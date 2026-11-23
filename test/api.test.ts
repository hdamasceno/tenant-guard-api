import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/auth/tokens.ts';
import { createApp } from '../src/http/app.ts';
import { TEST_SECRET, makeTenant, resetDb, testDb } from './helpers.ts';

const logs: string[] = [];
const app = () => createApp({ prisma: testDb(), jwtSecret: TEST_SECRET, log: (l) => logs.push(l) });

let north: Awaited<ReturnType<typeof makeTenant>>;
let south: Awaited<ReturnType<typeof makeTenant>>;

const as = (token: string) => ({
  get: (url: string) => request(app()).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body?: object) => request(app()).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body?: object) => request(app()).patch(url).set('Authorization', `Bearer ${token}`).send(body),
  delete: (url: string) => request(app()).delete(url).set('Authorization', `Bearer ${token}`),
});

async function course(token: string, slug: string, code: string, capacity = 3) {
  const res = await as(token).post(`/t/${slug}/courses`, { code, title: `Course ${code}`, capacity });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function student(token: string, slug: string, name: string) {
  const res = await as(token).post(`/t/${slug}/students`, { name, email: `${name.toLowerCase()}@example.test` });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

beforeEach(async () => {
  await resetDb();
  logs.length = 0;
  north = await makeTenant('north');
  south = await makeTenant('south');
});

afterAll(async () => {
  await testDb().$disconnect();
});

describe('system routes', () => {
  it('reports health and serves the OpenAPI document', async () => {
    expect((await request(app()).get('/health')).body).toEqual({ ok: true });
    const doc = await request(app()).get('/openapi.json');
    expect(doc.body.openapi).toBe('3.1.0');
    expect(doc.headers['x-content-type-options']).toBe('nosniff');
    expect(doc.headers['x-powered-by']).toBeUndefined();
  });

  it('lists the caller’s tenants on /me', async () => {
    const res = await as(north.staff.token).get('/me');
    expect(res.body.tenants).toEqual([{ slug: 'north', name: 'north academy', role: 'STAFF' }]);
  });

  it('answers unknown routes with a JSON 404', async () => {
    expect((await request(app()).get('/nope')).body).toEqual({ error: 'not_found' });
  });
});

describe('authentication', () => {
  it('rejects missing, malformed, tampered and expired tokens', async () => {
    expect((await request(app()).get('/t/north/courses')).status).toBe(401);
    expect((await as('not-a-jwt').get('/t/north/courses')).status).toBe(401);
    const forged = await signAccessToken(north.owner.id, 'a-different-secret-that-is-long-enough!!');
    expect((await as(forged).get('/t/north/courses')).status).toBe(401);
    const expired = await signAccessToken(north.owner.id, TEST_SECRET, '-1s');
    expect((await as(expired).get('/t/north/courses')).body).toEqual({ error: 'unauthorized' });
  });
});

describe('tenant resolution', () => {
  it('gives the same 404 for a tenant that does not exist and one you are not in', async () => {
    const missing = await as(north.owner.token).get('/t/nowhere/courses');
    const foreign = await as(north.owner.token).get('/t/south/courses');
    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  });
});

describe('roles', () => {
  it('lets viewers read but not write', async () => {
    expect((await as(north.viewer.token).get('/t/north/courses')).status).toBe(200);
    const res = await as(north.viewer.token).post('/t/north/courses', { code: 'X-1', title: 'x', capacity: 1 });
    expect(res.status).toBe(403);
  });

  it('only lets owners delete courses', async () => {
    const c = await course(north.staff.token, 'north', 'BIO-101');
    expect((await as(north.staff.token).delete(`/t/north/courses/${c.id}`)).status).toBe(403);
    expect((await as(north.owner.token).delete(`/t/north/courses/${c.id}`)).status).toBe(204);
    expect((await as(north.owner.token).get(`/t/north/courses/${c.id}`)).status).toBe(404);
  });
});

describe('cross-tenant attacks', () => {
  it('cannot read, change or delete another tenant’s course through its own tenant path', async () => {
    const southCourse = await course(south.owner.token, 'south', 'SECRET-1');
    const attacker = as(north.owner.token);
    expect((await attacker.get(`/t/north/courses/${southCourse.id}`)).status).toBe(404);
    expect((await attacker.patch(`/t/north/courses/${southCourse.id}`, { title: 'pwned' })).status).toBe(404);
    expect((await attacker.delete(`/t/north/courses/${southCourse.id}`)).status).toBe(404);
    expect((await attacker.get(`/t/north/courses/${southCourse.id}/enrollments`)).status).toBe(404);

    const intact = await as(south.viewer.token).get(`/t/south/courses/${southCourse.id}`);
    expect(intact.body).toMatchObject({ title: 'Course SECRET-1' });
  });

  it('cannot enrol another tenant’s student', async () => {
    const c = await course(north.staff.token, 'north', 'ART-1');
    const outsider = await student(south.staff.token, 'south', 'Mallory');
    const res = await as(north.staff.token).post(`/t/north/courses/${c.id}/enrollments`, { studentId: outsider.id });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'student_not_found' });
  });

  it('rejects a body that tries to set tenantId', async () => {
    const res = await as(north.staff.token).post('/t/north/courses', {
      code: 'X-2',
      title: 'x',
      capacity: 1,
      tenantId: south.tenant.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('never returns tenantId in responses', async () => {
    await course(north.staff.token, 'north', 'GEO-1');
    const res = await as(north.viewer.token).get('/t/north/courses');
    expect(JSON.stringify(res.body)).not.toContain('tenantId');
    expect(JSON.stringify(res.body)).not.toContain(north.tenant.id);
  });

  it('lists only the current tenant’s data', async () => {
    await course(north.staff.token, 'north', 'N-1');
    await course(south.staff.token, 'south', 'S-1');
    const res = await as(north.viewer.token).get('/t/north/courses');
    expect(res.body.items.map((c: { code: string }) => c.code)).toEqual(['N-1']);
  });
});

describe('validation', () => {
  it('reports field errors', async () => {
    const res = await as(north.staff.token).post('/t/north/courses', { code: 'bad code', title: '', capacity: 0 });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.details.fieldErrors).sort()).toEqual(['capacity', 'code', 'title']);
  });

  it('treats a malformed id in the path as not found', async () => {
    expect((await as(north.viewer.token).get('/t/north/courses/123')).status).toBe(404);
  });

  it('rejects broken JSON', async () => {
    const res = await request(app())
      .post('/t/north/courses')
      .set('Authorization', `Bearer ${north.staff.token}`)
      .set('Content-Type', 'application/json')
      .send('{"code":');
    expect(res.body).toEqual({ error: 'invalid_json' });
  });

  it('rejects an empty update and bad paging input', async () => {
    const c = await course(north.staff.token, 'north', 'EMPTY-1');
    expect((await as(north.staff.token).patch(`/t/north/courses/${c.id}`, {})).status).toBe(400);
    expect((await as(north.viewer.token).get('/t/north/courses?limit=500')).status).toBe(400);
  });
});

describe('courses', () => {
  it('pages through results with a cursor', async () => {
    for (const code of ['C-5', 'C-1', 'C-4', 'C-2', 'C-3']) await course(north.staff.token, 'north', code);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/t/north/courses?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await as(north.viewer.token).get(url);
      seen.push(...res.body.items.map((c: { code: string }) => c.code));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['C-1', 'C-2', 'C-3', 'C-4', 'C-5']);
  });

  it('keeps course codes unique per tenant only', async () => {
    await course(north.staff.token, 'north', 'MATH-1');
    const dup = await as(north.staff.token).post('/t/north/courses', { code: 'MATH-1', title: 'again', capacity: 1 });
    expect(dup.body).toEqual({ error: 'course_code_taken' });
    await course(south.staff.token, 'south', 'MATH-1');
  });

  it('will not shrink capacity below current enrolments', async () => {
    const c = await course(north.staff.token, 'north', 'CHEM-1', 3);
    for (const n of ['Ann', 'Ben']) {
      const s = await student(north.staff.token, 'north', n);
      await as(north.staff.token).post(`/t/north/courses/${c.id}/enrollments`, { studentId: s.id });
    }
    const res = await as(north.staff.token).patch(`/t/north/courses/${c.id}`, { capacity: 1 });
    expect(res.body).toEqual({ error: 'capacity_below_enrolled' });
    const ok = await as(north.staff.token).patch(`/t/north/courses/${c.id}`, { capacity: 2, title: 'Chemistry' });
    expect(ok.body).toMatchObject({ capacity: 2, enrolled: 2, title: 'Chemistry' });
  });
});

describe('enrolments', () => {
  it('enrols, lists, refuses duplicates and removes', async () => {
    const c = await course(north.staff.token, 'north', 'HIST-1');
    const s = await student(north.staff.token, 'north', 'Cleo');
    const first = await as(north.staff.token).post(`/t/north/courses/${c.id}/enrollments`, { studentId: s.id });
    expect(first.status).toBe(201);
    const again = await as(north.staff.token).post(`/t/north/courses/${c.id}/enrollments`, { studentId: s.id });
    expect(again.body).toEqual({ error: 'already_enrolled' });

    const list = await as(north.viewer.token).get(`/t/north/courses/${c.id}/enrollments`);
    expect(list.body.items).toEqual([expect.objectContaining({ student: { id: s.id, name: 'Cleo' } })]);
    const detail = await as(north.viewer.token).get(`/t/north/students/${s.id}`);
    expect(detail.body.courses).toEqual([{ id: c.id, code: 'HIST-1', title: 'Course HIST-1' }]);

    expect((await as(north.staff.token).delete(`/t/north/enrollments/${first.body.id}`)).status).toBe(204);
    expect((await as(north.staff.token).delete(`/t/north/enrollments/${first.body.id}`)).status).toBe(404);
  });

  it('never overbooks a course under concurrent requests', async () => {
    const c = await course(north.staff.token, 'north', 'POP-1', 3);
    const students = [];
    for (let i = 0; i < 8; i += 1) students.push(await student(north.staff.token, 'north', `S${i}`));

    const results = await Promise.all(
      students.map((s) => as(north.staff.token).post(`/t/north/courses/${c.id}/enrollments`, { studentId: s.id })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 409, 409, 409, 409, 409]);
    const after = await as(north.viewer.token).get(`/t/north/courses/${c.id}`);
    expect(after.body.enrolled).toBe(3);
  });

  it('removes enrolments with their course', async () => {
    const c = await course(north.staff.token, 'north', 'GONE-1');
    const s = await student(north.staff.token, 'north', 'Dee');
    await as(north.staff.token).post(`/t/north/courses/${c.id}/enrollments`, { studentId: s.id });
    await as(north.owner.token).delete(`/t/north/courses/${c.id}`);
    expect((await as(north.viewer.token).get(`/t/north/students/${s.id}`)).body.courses).toEqual([]);
  });

  it('keeps student emails unique per tenant, case-insensitively', async () => {
    await student(north.staff.token, 'north', 'Eli');
    const dup = await as(north.staff.token).post('/t/north/students', { name: 'Eli 2', email: 'ELI@example.test' });
    expect(dup.body).toEqual({ error: 'student_email_taken' });
  });
});
