// Tests for check-secrets.mjs. Run with: node --test "scripts/*.test.mjs"
// Fake secrets are assembled at runtime so this file never contains one.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkFileName, scanContent } from './check-secrets.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-secrets.mjs');
const j = (...parts) => parts.join('');
const fake = {
  privateKey: j('-----', 'BEGIN RSA PRIVATE KEY', '-----'),
  opensshKey: j('-----', 'BEGIN OPENSSH PRIVATE KEY', '-----'),
  aws: j('AKIA', 'Z'.repeat(8), '7'.repeat(8)),
  github: j('ghp', '_', 'a1B2'.repeat(9)),
  slack: j('xox', 'b-', '1234567890-abcdef'),
  stripe: j('sk', '_live_', 'x'.repeat(24)),
  google: j('AI', 'za', 'S'.repeat(35)),
  anthropic: j('sk-', 'ant-', 'api03-', 'q'.repeat(30)),
  remoteDb: j('postgres', '://app:', 's3cr3t', '@db.example.net:5432/app'),
};

describe('scanContent', () => {
  for (const [kind, value] of Object.entries(fake)) {
    it(`flags a ${kind}`, () => {
      const findings = scanContent(`const x = 1;\nconst value = "${value}";\n`);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].line, 2);
    });
  }

  it('allows local and placeholder connection strings', () => {
    const text = [
      'DATABASE_URL=postgresql://ci:ci@localhost:5432/app',
      'DATABASE_URL=postgresql://user:password@127.0.0.1:5433/app',
      'url: postgres://postgres:postgres@db:5432/app',
      'DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB',
    ].join('\n');
    assert.deepEqual(scanContent(text), []);
  });

  it('ignores ordinary code that mentions secrets', () => {
    const text = 'const secret = process.env.JWT_SECRET;\n// see the "-----" separator\nconst ask = "sk-short";';
    assert.deepEqual(scanContent(text), []);
  });

  it('ignores lock file integrity hashes', () => {
    const text = `      "integrity": "sha512-${fake.aws}${fake.google}=="`;
    assert.deepEqual(scanContent(text), []);
  });

  it('honours the allow marker', () => {
    assert.deepEqual(scanContent(`const k = "${fake.stripe}"; // secret-scan: allow`), []);
  });
});

describe('checkFileName', () => {
  it('blocks env files but not the example', () => {
    assert.ok(checkFileName('.env'));
    assert.ok(checkFileName('config/.env.production'));
    assert.ok(checkFileName('.env.local'));
    assert.equal(checkFileName('.env.example'), null);
  });

  it('blocks keys and certificates', () => {
    for (const f of ['server.pem', 'tls/site.key', 'AuthKey_ABC.p8', 'release.jks', 'id_ed25519', '.npmrc']) {
      assert.ok(checkFileName(f), f);
    }
  });

  it('lets source files through', () => {
    for (const f of ['src/keys.ts', 'id_rsa.pub', 'README.md', 'monkey.png']) assert.equal(checkFileName(f), null, f);
  });
});

describe('pre-commit run on a real repository', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'secret-scan-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, SECRET_SCAN_NO_GITLEAKS: '1' },
    });

  git('init', '-q');

  it('passes when the staged files are clean', () => {
    writeFileSync(path.join(dir, 'app.js'), 'console.log("hello");\n');
    writeFileSync(path.join(dir, '.env.example'), 'API_KEY=replace-me\n');
    git('add', 'app.js', '.env.example');
    const r = run();
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks a staged key and a staged .env, without printing the value', () => {
    writeFileSync(path.join(dir, 'config.js'), `export const token = "${fake.github}";\n`);
    writeFileSync(path.join(dir, '.env'), 'API_KEY=whatever\n');
    git('add', '-f', 'config.js', '.env');
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /config\.js:1: looks like a GitHub token/);
    assert.match(r.stderr, /\.env: environment file/);
    assert.ok(!r.stderr.includes(fake.github));
  });

  it('scans what is staged, not the working copy', () => {
    git('rm', '-q', '--cached', 'config.js', '.env');
    writeFileSync(path.join(dir, 'app.js'), `const k = "${fake.aws}";\n`); // edited but not staged
    assert.equal(run().status, 0);
  });

  it('--all scans every tracked file', () => {
    git('add', 'app.js');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--no-verify', '-m', 'x');
    const r = run('--all');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /app\.js:1: looks like a AWS access key id/);
  });
});
