import { z } from 'zod';
import type { CloudflareClientConfig } from './cloudflare-client.js';

export interface DaemonConfig {
  supabaseUrl?: string | undefined;
  supabaseAnonKey?: string | undefined;
  cloudflareApiUrl?: string | undefined;
  sessionToken?: string | undefined;
  machineId?: string | undefined;
  machineName: string;
  agyCommand: string;
  workspaceAllowlist: readonly string[];
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
}

const positiveInteger = z.coerce.number().int().positive('must be positive');

const envSchema = z.object({
  REMOTE_HANDS_SUPABASE_URL: z.string().url().optional(),
  REMOTE_HANDS_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  REMOTE_HANDS_CLOUDFLARE_API_URL: z.string().url().optional(),
  REMOTE_HANDS_API_URL: z.string().url().optional(),
  REMOTE_HANDS_SESSION_TOKEN: z.string().min(1).optional(),
  REMOTE_HANDS_MACHINE_ID: z.string().uuid().optional(),
  REMOTE_HANDS_MACHINE_NAME: z.string().min(1).default('default-machine'),
  REMOTE_HANDS_AGY_COMMAND: z.string().min(1).default('agy'),
  REMOTE_HANDS_WORKSPACE_ALLOWLIST: z.string().optional(),
  REMOTE_HANDS_POLL_INTERVAL_MS: positiveInteger.default(5_000),
  REMOTE_HANDS_HEARTBEAT_INTERVAL_MS: positiveInteger.default(60_000),
}).refine(
  (data) => Boolean(data.REMOTE_HANDS_SUPABASE_URL || data.REMOTE_HANDS_CLOUDFLARE_API_URL || data.REMOTE_HANDS_API_URL),
  {
    message: 'REMOTE_HANDS_SUPABASE_URL or REMOTE_HANDS_API_URL is required',
    path: ['REMOTE_HANDS_SUPABASE_URL'],
  },
);

function parseWorkspaceAllowlist(value: string | undefined): readonly string[] {
  if (value === undefined || value.length === 0) return [];

  const entries = value.split(':');
  if (entries.some((entry) => entry.trim().length === 0)) {
    throw new Error('REMOTE_HANDS_WORKSPACE_ALLOWLIST contains an empty entry');
  }

  return entries.map((entry) => entry.trim());
}

export function parseDaemonConfig(env: Record<string, string | undefined>): DaemonConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(message);
  }

  return {
    supabaseUrl: parsed.data.REMOTE_HANDS_SUPABASE_URL,
    supabaseAnonKey: parsed.data.REMOTE_HANDS_SUPABASE_ANON_KEY,
    cloudflareApiUrl: parsed.data.REMOTE_HANDS_CLOUDFLARE_API_URL ?? parsed.data.REMOTE_HANDS_API_URL,
    sessionToken: parsed.data.REMOTE_HANDS_SESSION_TOKEN,
    machineId: parsed.data.REMOTE_HANDS_MACHINE_ID,
    machineName: parsed.data.REMOTE_HANDS_MACHINE_NAME,
    agyCommand: parsed.data.REMOTE_HANDS_AGY_COMMAND,
    workspaceAllowlist: parseWorkspaceAllowlist(parsed.data.REMOTE_HANDS_WORKSPACE_ALLOWLIST),
    pollIntervalMs: parsed.data.REMOTE_HANDS_POLL_INTERVAL_MS,
    heartbeatIntervalMs: parsed.data.REMOTE_HANDS_HEARTBEAT_INTERVAL_MS,
  };
}

export function parseCloudflareClientConfig(
  env: Record<string, string | undefined>,
): CloudflareClientConfig {
  const baseUrl = env.REMOTE_HANDS_CLOUDFLARE_API_URL || env.REMOTE_HANDS_API_URL;
  const sessionToken = env.REMOTE_HANDS_SESSION_TOKEN;

  if (!baseUrl) {
    throw new Error('REMOTE_HANDS_CLOUDFLARE_API_URL or REMOTE_HANDS_API_URL is required');
  }
  if (!sessionToken) {
    throw new Error('REMOTE_HANDS_SESSION_TOKEN is required');
  }

  return {
    baseUrl,
    sessionToken,
  };
}

