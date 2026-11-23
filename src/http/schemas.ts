import { z } from 'zod';

// ---- shared ----

export const ErrorBody = z
  .object({ error: z.string(), details: z.unknown().optional() })
  .meta({ id: 'Error' });

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});

const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.uuid().nullable() });

// ---- courses ----

export const CourseParams = z.object({ courseId: z.uuid() });

const code = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,15}$/, '2-16 characters: A-Z, 0-9 and dashes');

// Strict objects reject unknown keys, so a client cannot slip in `tenantId`.
export const CourseCreate = z
  .strictObject({
    code,
    title: z.string().trim().min(1).max(200),
    capacity: z.int().min(1).max(1000),
  })
  .meta({ id: 'CourseCreate' });

export const CourseUpdate = CourseCreate.partial()
  .refine((o) => Object.keys(o).length > 0, 'at least one field is required')
  .meta({ id: 'CourseUpdate' });

export const Course = z
  .object({
    id: z.uuid(),
    code: z.string(),
    title: z.string(),
    capacity: z.int(),
    enrolled: z.int(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Course' });

export const CoursePage = page(Course).meta({ id: 'CoursePage' });

// ---- students ----

export const StudentParams = z.object({ studentId: z.uuid() });

export const StudentCreate = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    email: z.email().max(254).transform((e) => e.toLowerCase()),
  })
  .meta({ id: 'StudentCreate' });

export const Student = z
  .object({ id: z.uuid(), name: z.string(), email: z.string(), createdAt: z.iso.datetime() })
  .meta({ id: 'Student' });

export const StudentDetail = Student.extend({
  courses: z.array(z.object({ id: z.uuid(), code: z.string(), title: z.string() })),
}).meta({ id: 'StudentDetail' });

export const StudentPage = page(Student).meta({ id: 'StudentPage' });

// ---- enrollments ----

export const EnrollmentParams = z.object({ enrollmentId: z.uuid() });
export const EnrollmentCreate = z.strictObject({ studentId: z.uuid() }).meta({ id: 'EnrollmentCreate' });

export const Enrollment = z
  .object({
    id: z.uuid(),
    courseId: z.uuid(),
    student: z.object({ id: z.uuid(), name: z.string() }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Enrollment' });

export const EnrollmentList = z.object({ items: z.array(Enrollment) }).meta({ id: 'EnrollmentList' });

// ---- global ----

export const Me = z
  .object({
    id: z.uuid(),
    email: z.string(),
    name: z.string(),
    tenants: z.array(z.object({ slug: z.string(), name: z.string(), role: z.enum(['OWNER', 'STAFF', 'VIEWER']) })),
  })
  .meta({ id: 'Me' });
