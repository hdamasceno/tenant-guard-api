import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Db } from '../db/client.ts';
import { TenantViolationError } from '../db/tenant.ts';
import { Prisma } from '../generated/prisma/client.ts';
import { HttpError, notFound } from './errors.ts';
import { authenticate } from './middleware/auth.ts';
import { resolveTenant } from './middleware/tenant.ts';
import { buildOpenApi } from './openapi.ts';
import { type AnyRoute, mountRoutes } from './route.ts';
import { courseRoutes } from './routes/courses.ts';
import { enrollmentRoutes } from './routes/enrollments.ts';
import { studentRoutes } from './routes/students.ts';
import { Me } from './schemas.ts';

export const tenantRoutes: readonly AnyRoute[] = [...courseRoutes, ...studentRoutes, ...enrollmentRoutes];

export interface AppDeps {
  prisma: Db;
  jwtSecret: string;
  logRequests?: boolean;
  log?: (line: string) => void;
}

export function createApp({ prisma, jwtSecret, logRequests = false, log = console.log }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    next();
  });
  if (logRequests) app.use(requestLogger(log));
  app.use(express.json({ limit: '100kb' }));

  const openapi = buildOpenApi(tenantRoutes);

  app.get('/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  });
  app.get('/openapi.json', (_req, res) => {
    res.json(openapi);
  });

  const auth = authenticate(jwtSecret);

  app.get('/me', auth, async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.auth?.userId ?? '' },
      include: { memberships: { include: { tenant: true }, orderBy: { tenant: { slug: 'asc' } } } },
    });
    if (!user) throw notFound();
    res.json(
      Me.parse({
        id: user.id,
        email: user.email,
        name: user.name,
        tenants: user.memberships.map((m) => ({ slug: m.tenant.slug, name: m.tenant.name, role: m.role })),
      }),
    );
  });

  const tenantRouter = express.Router({ mergeParams: true });
  mountRoutes(tenantRouter, tenantRoutes, prisma);
  app.use('/t/:tenant', auth, resolveTenant(prisma), tenantRouter);

  app.use((_req, _res, next) => {
    next(notFound());
  });
  app.use(errorHandler(log));
  return app;
}

function requestLogger(log: (line: string) => void): RequestHandler {
  return (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      // Never log headers or bodies: they may hold tokens or personal data.
      log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${(performance.now() - start).toFixed(1)}ms`);
    });
    next();
  };
}

function errorHandler(log: (line: string) => void): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (err.code === 'P2002') {
        res.status(409).json({ error: 'conflict' });
        return;
      }
    }
    // A TenantViolationError is a programming error: log it loudly, reveal nothing.
    const kind = err instanceof TenantViolationError ? 'TENANT VIOLATION' : 'Unhandled error';
    log(`${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    res.status(500).json({ error: 'internal_error' });
  };
}
