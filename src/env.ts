import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres connection string'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_REQUESTS: z.stringbool().default(false),
});

export type Env = z.infer<typeof EnvSchema>;

/** Fails fast at startup with a readable message instead of failing on first use. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
