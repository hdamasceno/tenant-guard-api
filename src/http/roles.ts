import type { Role } from '../generated/prisma/client.ts';

const RANK: Record<Role, number> = { VIEWER: 1, STAFF: 2, OWNER: 3 };

/** Roles are ordered: an OWNER can do everything a STAFF member can, and so on. */
export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}
