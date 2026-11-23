import { describe, expect, it } from 'vitest';
import { tenantRoutes } from '../src/http/app.ts';
import { buildOpenApi, toOpenApiPath } from '../src/http/openapi.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const doc: Json = buildOpenApi(tenantRoutes);

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

describe('OpenAPI document', () => {
  it('documents every mounted tenant route', () => {
    for (const r of tenantRoutes) {
      const op = doc.paths[`/t/{tenant}${toOpenApiPath(r.path)}`]?.[r.method];
      expect(op, `${r.method} ${r.path}`).toBeDefined();
      expect(op.description).toContain(r.minRole);
    }
  });

  it('declares every path placeholder as a parameter', () => {
    for (const [path, ops] of Object.entries(doc.paths as Record<string, Json>)) {
      const placeholders = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      for (const op of Object.values(ops)) {
        const declared = (op.parameters ?? []).filter((p: Json) => p.in === 'path').map((p: Json) => p.name).sort();
        expect(declared, path).toEqual(placeholders);
      }
    }
  });

  it('resolves every $ref to a component schema', () => {
    const names = Object.keys(doc.components.schemas);
    for (const ref of collectRefs(doc.paths)) {
      expect(names).toContain(ref.replace('#/components/schemas/', ''));
    }
    expect(collectRefs(doc.components.schemas).every((r) => names.includes(r.replace('#/components/schemas/', '')))).toBe(true);
  });

  it('does not expose tenantId in any schema', () => {
    expect(JSON.stringify(doc.components.schemas)).not.toContain('tenantId');
  });

  it('marks query parameters with defaults as optional', () => {
    const list = doc.paths['/t/{tenant}/courses'].get;
    const limit = list.parameters.find((p: Json) => p.name === 'limit');
    expect(limit).toMatchObject({ in: 'query', required: false });
  });
});
