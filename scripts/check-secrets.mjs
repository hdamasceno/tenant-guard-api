#!/usr/bin/env node
// Blocks commits that would add private keys, tokens, credential files or real
// connection strings. No dependencies, so it runs before `npm install` has
// finished and on any machine with Node.
//
//   node scripts/check-secrets.mjs           scan the files staged for commit
//   node scripts/check-secrets.mjs --all     scan every tracked file (CI)
//
// When gitleaks is installed it also runs, as a second opinion. Exit code 1
// means something was found; nothing secret is ever printed in full.
//
// False positive? Add `secret-scan: allow` as a comment on that line.

import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DASHES = '-'.repeat(5);

/** File names that are credentials no matter what they contain. */
const BLOCKED_FILES = [
  { test: (f) => /^\.env(\..+)?$/.test(f) && f !== '.env.example', why: 'environment file (only .env.example may be committed)' },
  { test: (f) => /\.(pem|key|p8|p12|pfx|jks|keystore|mobileprovision|ppk)$/i.test(f), why: 'key or certificate file' },
  { test: (f) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(f), why: 'SSH private key' },
  { test: (f) => /^\.?(npmrc|netrc|pgpass)$/.test(f), why: 'file that usually holds credentials' },
];

/** Content patterns. Each one names what it found, never the value. */
const PATTERNS = [
  { name: 'private key', re: new RegExp(`${DASHES}BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?${DASHES}`) },
  { name: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'Stripe live key', re: /\b[rs]k_live_[A-Za-z0-9]{16,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?!ant-)(proj-|svcacct-)?[A-Za-z0-9_-]{40,}/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  {
    name: 'connection string with a password for a non-local host',
    re: /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|rediss|amqps?):\/\/[^\s:@/'"]+:[^\s@/'"]+@([^\s/:'"?]+)/,
    allow: (m) => /^(localhost|127\.0\.0\.1|\[::1\]|db|postgres|host)$/i.test(m[4] ?? ''),
  },
];

const ALLOW_MARKER = 'secret-scan: allow';
/** Lock files carry base64 hashes that can look like keys by chance. */
const IGNORED_LINE = /^\s*"(integrity|resolved)":/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function listFiles(all) {
  const out = all
    ? git(['ls-files', '-z'])
    : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return out.split('\0').filter(Boolean);
}

/** Reads the version of the file that would be committed (the index). */
function readStaged(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

export function scanContent(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARKER) || IGNORED_LINE.test(line)) return;
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (m && !(p.allow && p.allow(m))) findings.push({ line: i + 1, name: p.name });
    }
  });
  return findings;
}

export function checkFileName(file) {
  const base = path.posix.basename(file);
  return BLOCKED_FILES.find((rule) => rule.test(base))?.why ?? null;
}

function runGitleaks(all) {
  if (process.env.SECRET_SCAN_NO_GITLEAKS === '1') return true;
  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.log('secret scan: gitleaks not installed, built-in rules only (brew install gitleaks for a second opinion).');
    return true;
  }
  const args = all
    ? ['git', '--no-banner', '--redact', '--log-level', 'warn']
    : ['git', '--pre-commit', '--staged', '--no-banner', '--redact', '--log-level', 'warn'];
  const result = spawnSync('gitleaks', args, { stdio: 'inherit' });
  return result.status === 0;
}

function main() {
  const all = process.argv.includes('--all');
  const files = listFiles(all);
  const problems = [];

  for (const file of files) {
    const why = checkFileName(file);
    if (why) {
      problems.push(`${file}: ${why}`);
      continue;
    }
    const buf = readStaged(file);
    if (!buf || buf.includes(0)) continue; // deleted, or binary
    for (const f of scanContent(buf.toString('utf8'))) problems.push(`${file}:${f.line}: looks like a ${f.name}`);
  }

  const gitleaksOk = runGitleaks(all);

  if (problems.length > 0) {
    console.error(`\nsecret scan: blocked, ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nMove the value into an untracked .env file and read it from the environment.' +
        `\nIf a line is a false positive, add a "${ALLOW_MARKER}" comment to it.` +
        '\nTo unstage a file: git restore --staged <file>\n',
    );
  }
  if (!gitleaksOk) console.error('secret scan: gitleaks reported a leak (values redacted above).');

  if (problems.length > 0 || !gitleaksOk) process.exit(1);
  console.log(`secret scan: ${files.length} file(s) clean.`);
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === entry) main();
