import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// Resolve paths from the server root so scripts can run from any directory.
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const boolFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

// CLIENT_ORIGIN is a comma-separated allow-list (production + preview URLs).
const originList = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
        .every((origin) => {
          try {
            const url = new URL(origin);
            return url.protocol === 'http:' || url.protocol === 'https:';
          } catch {
            return false;
          }
        }),
    'CLIENT_ORIGIN must be a comma-separated list of valid http(s) URLs',
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  CLIENT_ORIGIN: originList.default('http://localhost:5173'),

  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1).default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1).default('vitalis'),
  // Managed MySQL providers (Aiven, Railway, PlanetScale, ...) require TLS.
  DB_SSL: z.string().optional().transform((v) => v === 'true' || v === '1'),
  // Serverless functions should keep this small (2-5).
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(12),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  COOKIE_NAME: z.string().min(1).default('vitalis_token'),
  // 'none' is only needed when the API is called directly on another domain.
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  LLM_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('openai/gpt-oss-20b'),

  TRUST_PROXY: z.string().optional().transform((v) => v === 'true'),
  RATE_LIMIT_DISABLED: z.string().optional().transform((v) => v === 'true'),
  // Set automatically by Vercel. Used to enable proxy trust and low pool sizes.
  VERCEL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const data = parsed.data;

export const env = {
  ...data,
  IS_PROD: data.NODE_ENV === 'production',
  IS_TEST: data.NODE_ENV === 'test',
  IS_VERCEL: Boolean(data.VERCEL),
  LLM_ENABLED: Boolean(data.LLM_API_KEY),
};

export { boolFromString };
