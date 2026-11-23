import { z } from 'zod';
import type { AnyRoute } from './route.ts';
import { ErrorBody, Me } from './schemas.ts';

type Json = Record<string, unknown>;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Invalid input',
  401: 'Missing or invalid token',
  403: 'Role too low for this action',
  404: 'Not found (or not in this tenant)',
  409: 'Conflict',
};

function ref(schema: z.ZodType): Json {
  const id = z.globalRegistry.get(schema)?.id;
  if (!id) throw new Error('Request and response bodies must have a .meta({ id }) to be documented');
  return { $ref: `#/components/schemas/${id}` };
}

function inlineSchema(schema: z.ZodType): Json {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  return rest;
}

function parameters(schema: z.ZodType | undefined, where: 'path' | 'query'): Json[] {
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.entries(schema.shape as Record<string, z.ZodType>).map(([name, field]) => ({
    name,
    in: where,
    required: where === 'path' || !field.safeParse(undefined).success,
    schema: inlineSchema(field),
  }));
}

const errorResponse = (status: number, codes: string[]): Json => ({
  description: `${STATUS_TEXT[status] ?? 'Error'}${codes.length ? `: ${codes.join(', ')}` : ''}`,
  content: { 'application/json': { schema: ref(ErrorBody) } },
});

export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Builds an OpenAPI 3.1 document from the same route table that Express mounts. */
export function buildOpenApi(routes: readonly AnyRoute[]): Json {
  const paths: Record<string, Json> = {};

  for (const r of routes) {
    const path = `/t/{tenant}${toOpenApiPath(r.path)}`;
    const status = r.status ?? (r.response ? 200 : 204);
    const errorCodes = new Map<number, string[]>([[400, []], [401, []], [403, []], [404, []]]);
    for (const [s, code] of r.errors ?? []) errorCodes.set(s, [...(errorCodes.get(s) ?? []), code]);

    const operation: Json = {
      tags: [r.tag],
      summary: r.summary,
      description: `Requires role ${r.minRole} or higher in the tenant.`,
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'tenant', in: 'path', required: true, schema: { type: 'string' }, description: 'Tenant slug' },
        ...parameters(r.params, 'path'),
        ...parameters(r.query, 'query'),
      ],
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(r.body) } } } } : {}),
      responses: {
        [status]: r.response
          ? { description: STATUS_TEXT[status], content: { 'application/json': { schema: ref(r.response) } } }
          : { description: STATUS_TEXT[status] },
        ...Object.fromEntries([...errorCodes].map(([s, codes]) => [s, errorResponse(s, codes)])),
      },
    };
    paths[path] = { ...(paths[path] ?? {}), [r.method]: operation };
  }

  paths['/health'] = { get: { tags: ['System'], summary: 'Liveness and database check', responses: { 200: { description: 'OK' } } } };
  paths['/me'] = {
    get: {
      tags: ['System'],
      summary: 'The caller and the tenants they belong to',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: ref(Me) } } },
        401: errorResponse(401, []),
      },
    },
  };

  const { schemas } = z.toJSONSchema(z.globalRegistry, {
    io: 'input',
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Json> };
  for (const s of Object.values(schemas)) {
    delete s.$schema;
    delete s.$id;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'tenant-guard-api',
      version: '0.1.0',
      description: 'Multi-tenant courses and enrolments API. Every tenant route lives under /t/{tenant}.',
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas,
    },
    paths,
  };
}
