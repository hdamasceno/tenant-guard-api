import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'tenant-guard-api';
const AUDIENCE = 'tenant-guard-api';

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** A short-lived HS256 access token whose subject is the user id. */
export async function signAccessToken(userId: string, secret: string, ttl = '1h'): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key(secret));
}

/** Returns the user id, or null for any invalid, expired or tampered token. */
export async function verifyAccessToken(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
