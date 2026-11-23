import type { RequestHandler } from 'express';
import type { Db } from '../../db/client.ts';
import type { Role } from '../../generated/prisma/client.ts';
import { forbidden, notFound } from '../errors.ts';
import { hasRole } from '../roles.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Resolves `:tenant` from the path to a tenant the caller belongs to.
 * An unknown tenant and a tenant the caller is not a member of both give 404.
 */
export function resolveTenant(prisma: Db): RequestHandler {
  return async (req, _res, next) => {
    const slug = req.params.tenant;
    const userId = req.auth?.userId;
    if (typeof slug !== 'string' || !SLUG.test(slug) || !userId) throw notFound();
    const membership = await prisma.membership.findFirst({
      where: { userId, tenant: { slug } },
      select: { role: true, tenant: { select: { id: true, slug: true } } },
    });
    if (!membership) throw notFound();
    req.tenant = { id: membership.tenant.id, slug: membership.tenant.slug, role: membership.role };
    next();
  };
}

export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.tenant || !hasRole(req.tenant.role, role)) throw forbidden();
    next();
  };
}
