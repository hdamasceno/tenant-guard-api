import { conflict, notFound } from '../errors.ts';
import { route } from '../route.ts';
import { Course, CourseCreate, CoursePage, CourseParams, CourseUpdate, PageQuery } from '../schemas.ts';

const withCount = { _count: { select: { enrollments: true } } } as const;

type Row = { id: string; code: string; title: string; capacity: number; createdAt: Date; _count: { enrollments: number } };

const toDto = (c: Row) => ({
  id: c.id,
  code: c.code,
  title: c.title,
  capacity: c.capacity,
  enrolled: c._count.enrollments,
  createdAt: c.createdAt.toISOString(),
});

export const courseRoutes = [
  route({
    method: 'get',
    path: '/courses',
    tag: 'Courses',
    summary: 'List courses, ordered by code (cursor pagination)',
    minRole: 'VIEWER',
    query: PageQuery,
    response: CoursePage,
    handler: async ({ db, query }) => {
      const rows = await db.course.findMany({
        include: withCount,
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
      const items = rows.slice(0, query.limit);
      return { items: items.map(toDto), nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null };
    },
  }),

  route({
    method: 'post',
    path: '/courses',
    tag: 'Courses',
    summary: 'Create a course',
    minRole: 'STAFF',
    body: CourseCreate,
    response: Course,
    status: 201,
    errors: [[409, 'course_code_taken']],
    handler: async ({ db, tenant, body }) => {
      const taken = await db.course.findFirst({ where: { code: body.code }, select: { id: true } });
      if (taken) throw conflict('course_code_taken');
      const c = await db.course.create({ data: { ...body, tenantId: tenant.id }, include: withCount });
      return toDto(c);
    },
  }),

  route({
    method: 'get',
    path: '/courses/:courseId',
    tag: 'Courses',
    summary: 'Get one course',
    minRole: 'VIEWER',
    params: CourseParams,
    response: Course,
    handler: async ({ db, params }) => {
      const c = await db.course.findUnique({ where: { id: params.courseId }, include: withCount });
      if (!c) throw notFound();
      return toDto(c);
    },
  }),

  route({
    method: 'patch',
    path: '/courses/:courseId',
    tag: 'Courses',
    summary: 'Update a course',
    minRole: 'STAFF',
    params: CourseParams,
    body: CourseUpdate,
    response: Course,
    errors: [[409, 'course_code_taken'], [409, 'capacity_below_enrolled']],
    handler: async ({ db, params, body }) => {
      const current = await db.course.findUnique({ where: { id: params.courseId }, include: withCount });
      if (!current) throw notFound();
      if (body.capacity !== undefined && body.capacity < current._count.enrollments) {
        throw conflict('capacity_below_enrolled');
      }
      if (body.code && body.code !== current.code) {
        const taken = await db.course.findFirst({ where: { code: body.code }, select: { id: true } });
        if (taken) throw conflict('course_code_taken');
      }
      const c = await db.course.update({ where: { id: params.courseId }, data: body, include: withCount });
      return toDto(c);
    },
  }),

  route({
    method: 'delete',
    path: '/courses/:courseId',
    tag: 'Courses',
    summary: 'Delete a course and its enrolments (owners only)',
    minRole: 'OWNER',
    params: CourseParams,
    handler: async ({ db, params }) => {
      const { count } = await db.course.deleteMany({ where: { id: params.courseId } });
      if (count === 0) throw notFound();
    },
  }),
];
