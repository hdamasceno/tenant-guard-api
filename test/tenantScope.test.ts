import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantViolationError, withTenant } from '../src/db/tenant.ts';
import type { Prisma } from '../src/generated/prisma/client.ts';
import { makeTenant, resetDb, testDb } from './helpers.ts';

let a: Awaited<ReturnType<typeof makeTenant>>;
let b: Awaited<ReturnType<typeof makeTenant>>;

beforeEach(async () => {
  await resetDb();
  a = await makeTenant('north');
  b = await makeTenant('south');
  const db = testDb();
  await db.course.create({ data: { tenantId: a.tenant.id, code: 'A-101', title: 'North course', capacity: 2 } });
  await db.course.create({ data: { tenantId: b.tenant.id, code: 'B-101', title: 'South course', capacity: 2 } });
});

afterAll(async () => {
  await testDb().$disconnect();
});

describe('Prisma tenant extension', () => {
  it('filters reads to the current tenant', async () => {
    const codes = await withTenant(testDb(), a.tenant.id, (db) => db.course.findMany({ select: { code: true } }));
    expect(codes).toEqual([{ code: 'A-101' }]);
  });

  it('cannot read another tenant row even by its primary key', async () => {
    const other = await testDb().course.findFirstOrThrow({ where: { tenantId: b.tenant.id } });
    const found = await withTenant(testDb(), a.tenant.id, (db) => db.course.findUnique({ where: { id: other.id } }));
    expect(found).toBeNull();
  });

  it('stamps the tenant on create', async () => {
    const created = await withTenant(testDb(), a.tenant.id, (db) =>
      // The generated types require tenantId; leaving it out shows the extension stamps it.
      db.student.create({ data: { name: 'Ada', email: 'ada@example.test' } as unknown as Prisma.StudentUncheckedCreateInput }),
    );
    expect(created.tenantId).toBe(a.tenant.id);
  });

  it('refuses to write into another tenant', async () => {
    await expect(
      withTenant(testDb(), a.tenant.id, (db) =>
        db.student.create({ data: { tenantId: b.tenant.id, name: 'Eve', email: 'eve@example.test' } }),
      ),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it('cannot update or delete another tenant row', async () => {
    const other = await testDb().course.findFirstOrThrow({ where: { tenantId: b.tenant.id } });
    const updated = await withTenant(testDb(), a.tenant.id, (db) =>
      db.course.updateMany({ where: { id: other.id }, data: { title: 'hacked' } }),
    );
    expect(updated.count).toBe(0);
    const deleted = await withTenant(testDb(), a.tenant.id, (db) => db.course.deleteMany({}));
    expect(deleted.count).toBe(1); // only its own course
    expect(await testDb().course.count({ where: { tenantId: b.tenant.id } })).toBe(1);
  });

  it('refuses to touch global models through the scoped client', async () => {
    await expect(withTenant(testDb(), a.tenant.id, (db) => db.user.findMany())).rejects.toBeInstanceOf(
      TenantViolationError,
    );
  });
});

describe('Postgres row-level security', () => {
  it('limits even raw SQL to the current tenant', async () => {
    const rows = await withTenant(testDb(), a.tenant.id, (db) =>
      db.$queryRaw<{ code: string }[]>`SELECT code FROM "Course" ORDER BY code`,
    );
    expect(rows).toEqual([{ code: 'A-101' }]);
  });

  it('rejects a raw insert into another tenant', async () => {
    await expect(
      withTenant(testDb(), a.tenant.id, (db) =>
        db.$executeRaw`INSERT INTO "Course" (id, "tenantId", code, title, capacity)
                       VALUES (gen_random_uuid(), ${b.tenant.id}::uuid, 'X-1', 'sneaky', 1)`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('shows nothing when no tenant is set', async () => {
    const rows = await testDb().$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_tenant`;
      return tx.$queryRaw<unknown[]>`SELECT * FROM "Course"`;
    });
    expect(rows).toEqual([]);
  });

  it('blocks writes to global tables from the tenant role', async () => {
    await expect(
      withTenant(testDb(), a.tenant.id, (db) => db.$executeRaw`UPDATE "Tenant" SET name = 'x'`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('composite foreign keys', () => {
  it('cannot enrol a student of one tenant in a course of another', async () => {
    const db = testDb();
    const course = await db.course.findFirstOrThrow({ where: { tenantId: a.tenant.id } });
    const student = await db.student.create({ data: { tenantId: b.tenant.id, name: 'Bo', email: 'bo@example.test' } });
    await expect(
      db.enrollment.create({ data: { tenantId: a.tenant.id, courseId: course.id, studentId: student.id } }),
    ).rejects.toThrow();
  });
});
