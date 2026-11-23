import { execFileSync } from 'node:child_process';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Tests run against a real Postgres, in a separate `<name>_test` database
 * (or TEST_DATABASE_URL), migrated before the first test.
 */
export default async function setup(project: TestProject) {
  try {
    process.loadEnvFile();
  } catch {
    // CI passes variables directly
  }
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and run `docker compose up -d`.');

  let testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    const url = new URL(base);
    const name = `${url.pathname.slice(1)}_test`;
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
    await admin.end();
    url.pathname = `/${name}`;
    testUrl = url.toString();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
  project.provide('databaseUrl', testUrl);
}
