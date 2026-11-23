import type { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { type TenantDb, withTenant } from '../db/tenant.ts';
import type { Role } from '../generated/prisma/client.ts';
import type { TenantContext } from '../types.d.ts';
import { HttpError, notFound } from './errors.ts';
import { requireRole } from './middleware/tenant.ts';

type Schema = z.ZodType;
type In<S> = S extends Schema ? z.output<S> : undefined;
// A route without a response schema answers 204 and its handler returns nothing.
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
type Out<S> = S extends Schema ? z.input<S> : void;

export interface RouteContext<P, Q, B> {
  db: TenantDb;
  tenant: TenantContext;
  userId: string;
  params: P;
  query: Q;
  body: B;
}

/**
 * One declaration per endpoint. The same object mounts the Express handler,
 * validates input, validates and strips the output, and feeds the OpenAPI document,
 * so the docs cannot drift from the code.
 */
export interface RouteDef<
  P extends Schema | undefined = undefined,
  Q extends Schema | undefined = undefined,
  B extends Schema | undefined = undefined,
  R extends Schema | undefined = undefined,
> {
  method: 'get' | 'post' | 'patch' | 'delete';
  /** Express-style path below `/t/:tenant`, e.g. `/courses/:courseId`. */
  path: string;
  summary: string;
  tag: string;
  minRole: Role;
  params?: P;
  query?: Q;
  body?: B;
  /** Leave out for 204 No Content. */
  response?: R;
  status?: number;
  /** Error codes this route can return, for the docs. */
  errors?: Array<[status: number, code: string]>;
  handler: (ctx: RouteContext<In<P>, In<Q>, In<B>>) => Promise<Out<R>>;
}

/**
 * The erased form kept in the route table. Each route was type-checked
 * against its own schemas by `route()` before being stored here.
 */
export interface AnyRoute {
  method: RouteDef['method'];
  path: string;
  summary: string;
  tag: string;
  minRole: Role;
  params?: Schema;
  query?: Schema;
  body?: Schema;
  response?: Schema;
  status?: number;
  errors?: Array<[status: number, code: string]>;
  handler: (ctx: RouteContext<unknown, unknown, unknown>) => Promise<unknown>;
}

export function route<
  P extends Schema | undefined = undefined,
  Q extends Schema | undefined = undefined,
  B extends Schema | undefined = undefined,
  R extends Schema | undefined = undefined,
>(def: RouteDef<P, Q, B, R>): AnyRoute {
  return def as unknown as AnyRoute;
}

function parse(schema: Schema, value: unknown, onFail: () => HttpError): unknown {
  const r = schema.safeParse(value);
  if (!r.success) {
    const err = onFail();
    throw err.status === 400 ? new HttpError(400, 'validation_error', z.flattenError(r.error)) : err;
  }
  return r.data;
}

export function mountRoutes(router: Router, routes: readonly AnyRoute[], prisma: Db): void {
  for (const r of routes) {
    router[r.method](r.path, requireRole(r.minRole), async (req, res) => {
      // A malformed id in the path is just "not found".
      const params = r.params ? parse(r.params, req.params, () => notFound()) : undefined;
      const query = r.query ? parse(r.query, req.query, () => new HttpError(400, 'validation_error')) : undefined;
      const body = r.body ? parse(r.body, req.body ?? {}, () => new HttpError(400, 'validation_error')) : undefined;
      const tenant = req.tenant as TenantContext;
      const userId = req.auth?.userId as string;
      const result = await withTenant(prisma, tenant.id, (db) =>
        r.handler({ db, tenant, userId, params, query, body }),
      );
      if (!r.response) {
        res.status(r.status ?? 204).end();
        return;
      }
      // Parsing the output strips anything not in the schema (e.g. tenantId).
      res.status(r.status ?? 200).json(r.response.parse(result));
    });
  }
}
