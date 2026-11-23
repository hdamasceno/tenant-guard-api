import { inject } from 'vitest';
import { signAccessToken } from '../src/auth/tokens.ts';
import { createPrisma, type Db } from '../src/db/client.ts';
import type { Role } from '../src/generated/prisma/client.ts';

export const TEST_SECRET = 'test-only-secret-that-is-long-enough-123';

let prisma: Db | undefined;

export function testDb(): Db {
  prisma ??= createPrisma(inject('databaseUrl'));
  return prisma;
}

export async function resetDb(): Promise<void> {
  await testDb().$executeRawUnsafe('TRUNCATE "Tenant", "User" CASCADE');
}

let seq = 0;

/** Creates a tenant with one member per role and returns their tokens. */
export async function makeTenant(slug: string) {
  const db = testDb();
  const tenant = await db.tenant.create({ data: { slug, name: `${slug} academy` } });
  const people: Partial<Record<Role, { id: string; token: string }>> = {};
  for (const role of ['OWNER', 'STAFF', 'VIEWER'] as const) {
    const user = await db.user.create({
      data: { email: `${role.toLowerCase()}-${++seq}@${slug}.example`, name: `${role} of ${slug}` },
    });
    await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role } });
    people[role] = { id: user.id, token: await signAccessToken(user.id, TEST_SECRET) };
  }
  return { tenant, owner: people.OWNER!, staff: people.STAFF!, viewer: people.VIEWER! };
}
