import { z } from 'zod';

export interface DaemonConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  machineName: string;
  agyCommand: string;
  workspaceAllowlist: readonly string[];
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
}

const positiveInteger = z.coerce.number().int().positive('must be positive');

const envSchema = z.object({
  REMOTE_HANDS_SUPABASE_URL: z.url(),
  REMOTE_HANDS_SUPABASE_ANON_KEY: z.string().min(1),
  REMOTE_HANDS_MACHINE_NAME: z.string().min(1),
  REMOTE_HANDS_AGY_COMMAND: z.string().min(1).default('agy'),
  REMOTE_HANDS_WORKSPACE_ALLOWLIST: z.string().optional(),
  REMOTE_HANDS_POLL_INTERVAL_MS: positiveInteger.default(5_000),
  REMOTE_HANDS_HEARTBEAT_INTERVAL_MS: positiveInteger.default(15_000),
});

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
    machineName: parsed.data.REMOTE_HANDS_MACHINE_NAME,
    agyCommand: parsed.data.REMOTE_HANDS_AGY_COMMAND,
    workspaceAllowlist: parseWorkspaceAllowlist(parsed.data.REMOTE_HANDS_WORKSPACE_ALLOWLIST),
    pollIntervalMs: parsed.data.REMOTE_HANDS_POLL_INTERVAL_MS,
    heartbeatIntervalMs: parsed.data.REMOTE_HANDS_HEARTBEAT_INTERVAL_MS,
  };
}

