import { createPrisma } from './db/client.ts';
import { loadEnv } from './env.ts';
import { createApp } from './http/app.ts';

try {
  process.loadEnvFile();
} catch {
  // no .env file: variables come from the environment
}

const env = loadEnv();
const prisma = createPrisma(env.DATABASE_URL);
const app = createApp({ prisma, jwtSecret: env.JWT_SECRET, logRequests: env.LOG_REQUESTS });

const server = app.listen(env.PORT, () => {
  console.log(`tenant-guard-api listening on http://localhost:${env.PORT}`);
});

const shutdown = () => {
  server.close(() => {
    void prisma.$disconnect().then(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
