/** An error with an HTTP status and a stable, machine-readable code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, details?: unknown) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Used for "does not exist" and "exists, but not in your tenant" alike,
 * so a caller can never learn that another tenant's id is real.
 */
export const notFound = (what = 'not_found') => new HttpError(404, what);
export const conflict = (code: string) => new HttpError(409, code);
export const forbidden = () => new HttpError(403, 'forbidden');
export const unauthorized = () => new HttpError(401, 'unauthorized');
