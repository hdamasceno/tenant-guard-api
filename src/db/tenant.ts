import { Prisma } from '../generated/prisma/client.ts';
import type { Db } from './client.ts';

/** Models that belong to a tenant. Everything else is global. */
export const TENANT_MODELS: ReadonlySet<string> = new Set(['Course', 'Student', 'Enrollment']);

/** Raised when code tries to cross a tenant boundary. Always a bug, never user error. */
export class TenantViolationError extends Error {
  override name = 'TenantViolationError';
}

const READ_OR_FILTER_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const UPDATE_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

type Data = Record<string, unknown>;

function checkTenantField(value: unknown, tenantId: string, where: string): void {
  if (value !== undefined && value !== tenantId) {
    throw new TenantViolationError(`${where} names another tenant`);
  }
}

function stampCreate(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => stampCreate(d, tenantId));
  if (typeof data !== 'object' || data === null) return data;
  const d = data as Data;
  checkTenantField(d.tenantId, tenantId, 'create data');
  if ('tenant' in d) throw new TenantViolationError('set the tenant through the scoped client, not the relation');
  return { ...d, tenantId };
}

function guardUpdate(data: unknown, tenantId: string): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const d = data as Data;
  checkTenantField(d.tenantId, tenantId, 'update data');
  if ('tenant' in d) throw new TenantViolationError('a row cannot move to another tenant');
  return d;
}

/**
 * A Prisma client extension that pins every query on a tenant-owned model to
 * one tenant: filters get `tenantId`, creates get it stamped in, and any attempt
 * to name a different tenant throws. Queries on global models are refused, so
 * code must reach for the unscoped client on purpose.
 *
 * Nested relation reads (include/select) are safe without help: tenant-owned
 * relations are composite (tenantId, id) foreign keys, so they cannot point
 * across tenants. Row-level security in Postgres backs all of this up.
 */
export function tenantScope(tenantId: string) {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) {
            throw new TenantViolationError(`${model} is global; use the unscoped client for it`);
          }
          const a = { ...(args as Data) };
          if (READ_OR_FILTER_OPS.has(operation)) {
            const where = (a.where ?? {}) as Data;
            checkTenantField(where.tenantId, tenantId, `${model}.${operation} filter`);
            a.where = { ...where, tenantId };
          }
          if (CREATE_OPS.has(operation)) a.data = stampCreate(a.data, tenantId);
          if (UPDATE_OPS.has(operation)) a.data = guardUpdate(a.data, tenantId);
          if (operation === 'upsert') {
            a.create = stampCreate(a.create, tenantId);
            a.update = guardUpdate(a.update, tenantId);
          }
          return query(a);
        },
      },
    },
  });
}

export type TenantDb = Prisma.TransactionClient;

/**
 * Runs `fn` in one transaction that is limited to `tenantId` twice over:
 * by the Prisma extension above, and by Postgres row-level security
 * (`SET LOCAL ROLE app_tenant` plus the `app.tenant_id` setting).
 */
export async function withTenant<T>(
  prisma: Db,
  tenantId: string,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const scoped = prisma.$extends(tenantScope(tenantId));
  return scoped.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_tenant`;
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx as TenantDb);
  });
}
