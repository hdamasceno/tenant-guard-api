/**
 * Development helper: prints an access token for a seeded user.
 *   npm run token -- olivia@harbor.example
 * There is no login endpoint; authentication is out of scope for this demo.
 */
import { signAccessToken } from '../src/auth/tokens.ts';
import { createPrisma } from '../src/db/client.ts';
import { loadEnv } from '../src/env.ts';

try {
  process.loadEnvFile();
} catch {
  // variables come from the environment
}

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run token -- <email>');
  process.exit(1);
}
const env = loadEnv();
const prisma = createPrisma(env.DATABASE_URL);
const user = await prisma.user.findUnique({ where: { email } });
await prisma.$disconnect();
if (!user) {
  console.error(`No user with email ${email}. Did you run npm run db:seed?`);
  process.exit(1);
}
console.log(await signAccessToken(user.id, env.JWT_SECRET, '8h'));
