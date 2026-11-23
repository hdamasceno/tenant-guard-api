/**
 * Invented demo data: two schools and a few people. Run with `npm run db:seed`.
 * Uses the unscoped client on purpose: seeding is an admin task that spans tenants.
 */
import { createPrisma } from '../src/db/client.ts';

try {
  process.loadEnvFile();
} catch {
  // variables come from the environment
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const prisma = createPrisma(url);

const tenants = [
  { slug: 'harbor-college', name: 'Harbor College', courses: [['CS-101', 'Intro to Programming', 30], ['MATH-201', 'Linear Algebra', 25]] },
  { slug: 'ridge-institute', name: 'Ridge Institute', courses: [['CS-101', 'Programming Basics', 20], ['ART-110', 'Drawing I', 12]] },
] as const;

const people = [
  { email: 'olivia@harbor.example', name: 'Olivia Owner', roles: { 'harbor-college': 'OWNER' } },
  { email: 'sam@harbor.example', name: 'Sam Staff', roles: { 'harbor-college': 'STAFF' } },
  { email: 'vera@ridge.example', name: 'Vera Viewer', roles: { 'ridge-institute': 'VIEWER' } },
  { email: 'max@both.example', name: 'Max Multi', roles: { 'harbor-college': 'STAFF', 'ridge-institute': 'OWNER' } },
] as const;

await prisma.$executeRawUnsafe('TRUNCATE "Tenant", "User" CASCADE');

const ids = new Map<string, string>();
for (const t of tenants) {
  const tenant = await prisma.tenant.create({ data: { slug: t.slug, name: t.name } });
  ids.set(t.slug, tenant.id);
  for (const [code, title, capacity] of t.courses) {
    await prisma.course.create({ data: { tenantId: tenant.id, code, title, capacity } });
  }
  for (const n of ['Avery', 'Blake', 'Casey']) {
    await prisma.student.create({
      data: { tenantId: tenant.id, name: `${n} (${t.name})`, email: `${n.toLowerCase()}@${t.slug}.example` },
    });
  }
}

for (const p of people) {
  const user = await prisma.user.create({ data: { email: p.email, name: p.name } });
  for (const [slug, role] of Object.entries(p.roles)) {
    await prisma.membership.create({ data: { tenantId: ids.get(slug) ?? '', userId: user.id, role } });
  }
}

console.log(`Seeded ${tenants.length} tenants and ${people.length} users. Get a token with: npm run token -- <email>`);
await prisma.$disconnect();
