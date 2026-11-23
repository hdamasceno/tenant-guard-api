import { conflict, notFound } from '../errors.ts';
import { route } from '../route.ts';
import { PageQuery, Student, StudentCreate, StudentDetail, StudentPage, StudentParams } from '../schemas.ts';

type Row = { id: string; name: string; email: string; createdAt: Date };
const toDto = (s: Row) => ({ id: s.id, name: s.name, email: s.email, createdAt: s.createdAt.toISOString() });

export const studentRoutes = [
  route({
    method: 'get',
    path: '/students',
    tag: 'Students',
    summary: 'List students, ordered by name (cursor pagination)',
    minRole: 'VIEWER',
    query: PageQuery,
    response: StudentPage,
    handler: async ({ db, query }) => {
      const rows = await db.student.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
      const items = rows.slice(0, query.limit);
      return { items: items.map(toDto), nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null };
    },
  }),

  route({
    method: 'post',
    path: '/students',
    tag: 'Students',
    summary: 'Register a student',
    minRole: 'STAFF',
    body: StudentCreate,
    response: Student,
    status: 201,
    errors: [[409, 'student_email_taken']],
    handler: async ({ db, tenant, body }) => {
      const taken = await db.student.findFirst({ where: { email: body.email }, select: { id: true } });
      if (taken) throw conflict('student_email_taken');
      return toDto(await db.student.create({ data: { ...body, tenantId: tenant.id } }));
    },
  }),

  route({
    method: 'get',
    path: '/students/:studentId',
    tag: 'Students',
    summary: 'Get a student and their courses',
    minRole: 'VIEWER',
    params: StudentParams,
    response: StudentDetail,
    handler: async ({ db, params }) => {
      const s = await db.student.findUnique({
        where: { id: params.studentId },
        include: { enrollments: { include: { course: { select: { id: true, code: true, title: true } } } } },
      });
      if (!s) throw notFound();
      return { ...toDto(s), courses: s.enrollments.map((e) => e.course).sort((a, b) => a.code.localeCompare(b.code)) };
    },
  }),
];
