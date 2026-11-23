import { conflict, notFound } from '../errors.ts';
import { route } from '../route.ts';
import { CourseParams, Enrollment, EnrollmentCreate, EnrollmentList, EnrollmentParams } from '../schemas.ts';

type Row = { id: string; courseId: string; createdAt: Date; student: { id: string; name: string } };
const toDto = (e: Row) => ({ id: e.id, courseId: e.courseId, student: e.student, createdAt: e.createdAt.toISOString() });
const studentSelect = { student: { select: { id: true, name: true } } } as const;

export const enrollmentRoutes = [
  route({
    method: 'get',
    path: '/courses/:courseId/enrollments',
    tag: 'Enrollments',
    summary: 'List the students enrolled in a course',
    minRole: 'VIEWER',
    params: CourseParams,
    response: EnrollmentList,
    handler: async ({ db, params }) => {
      const course = await db.course.findUnique({ where: { id: params.courseId }, select: { id: true } });
      if (!course) throw notFound();
      const rows = await db.enrollment.findMany({
        where: { courseId: params.courseId },
        include: studentSelect,
        orderBy: { createdAt: 'asc' },
      });
      return { items: rows.map(toDto) };
    },
  }),

  route({
    method: 'post',
    path: '/courses/:courseId/enrollments',
    tag: 'Enrollments',
    summary: 'Enrol a student; fails when the course is full',
    minRole: 'STAFF',
    params: CourseParams,
    body: EnrollmentCreate,
    response: Enrollment,
    status: 201,
    errors: [[404, 'student_not_found'], [409, 'course_full'], [409, 'already_enrolled']],
    handler: async ({ db, tenant, params, body }) => {
      // Lock the course row so concurrent enrolments are counted one at a time;
      // without this, two requests could both see one free seat and both take it.
      const locked = await db.$queryRaw<{ capacity: number }[]>`
        SELECT capacity FROM "Course" WHERE id = ${params.courseId}::uuid FOR UPDATE`;
      const course = locked[0];
      if (!course) throw notFound();

      const student = await db.student.findUnique({ where: { id: body.studentId }, select: { id: true } });
      if (!student) throw notFound('student_not_found');

      const existing = await db.enrollment.findFirst({
        where: { courseId: params.courseId, studentId: body.studentId },
        select: { id: true },
      });
      if (existing) throw conflict('already_enrolled');

      const taken = await db.enrollment.count({ where: { courseId: params.courseId } });
      if (taken >= course.capacity) throw conflict('course_full');

      const e = await db.enrollment.create({
        data: { tenantId: tenant.id, courseId: params.courseId, studentId: body.studentId },
        include: studentSelect,
      });
      return toDto(e);
    },
  }),

  route({
    method: 'delete',
    path: '/enrollments/:enrollmentId',
    tag: 'Enrollments',
    summary: 'Remove an enrolment',
    minRole: 'STAFF',
    params: EnrollmentParams,
    handler: async ({ db, params }) => {
      const { count } = await db.enrollment.deleteMany({ where: { id: params.enrollmentId } });
      if (count === 0) throw notFound();
    },
  }),
];
