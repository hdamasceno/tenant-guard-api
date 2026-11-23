import type { RequestHandler } from 'express';
import { verifyAccessToken } from '../../auth/tokens.ts';
import { unauthorized } from '../errors.ts';

/** Requires `Authorization: Bearer <token>` and sets `req.auth`. */
export function authenticate(secret: string): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    const userId = match?.[1] ? await verifyAccessToken(match[1], secret) : null;
    if (!userId) throw unauthorized();
    req.auth = { userId };
    next();
  };
}
