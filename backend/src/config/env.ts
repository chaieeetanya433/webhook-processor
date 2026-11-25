import { z } from 'zod';

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    PG_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    WORKER_ID: z.string().trim().min(1).default('worker-1'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60000).default(500),
    LEASE_MS: z.coerce.number().int().min(50).max(600000).default(15000),
    HEARTBEAT_MS: z.coerce.number().int().min(10).max(300000).default(4000),
    MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
    BACKOFF_BASE_MS: z.coerce.number().int().min(10).max(600000).default(1000),
    BACKOFF_MAX_MS: z.coerce.number().int().min(10).max(3600000).default(15000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(300000).default(10000),
  })
  .superRefine((val, ctx) => {
    if (val.HEARTBEAT_MS >= val.LEASE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HEARTBEAT_MS'],
        message: `HEARTBEAT_MS (${val.HEARTBEAT_MS}) must be less than LEASE_MS (${val.LEASE_MS})`,
      });
    }
    if (val.BACKOFF_MAX_MS < val.BACKOFF_BASE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BACKOFF_MAX_MS'],
        message: `BACKOFF_MAX_MS (${val.BACKOFF_MAX_MS}) must be >= BACKOFF_BASE_MS (${val.BACKOFF_BASE_MS})`,
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

const migrationEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
});

export function loadMigrationConfig(env: NodeJS.ProcessEnv = process.env): {
  DATABASE_URL: string;
} {
  const parsed = migrationEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error('Invalid environment configuration: DATABASE_URL is required');
  }
  return parsed.data;
}
