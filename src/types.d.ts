import type { Role } from './generated/prisma/client.ts';

export interface TenantContext {
  id: string;
  slug: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string };
      tenant?: TenantContext;
    }
  }
}
