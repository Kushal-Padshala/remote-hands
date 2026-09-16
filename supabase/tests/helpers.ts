import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

if (!anonKey || !serviceKey) {
  throw new Error(
    'Set SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. Run `npm run db:start` and copy them into .env.',
  );
}

export async function isSupabaseReachable(): Promise<boolean> {
  const socket = new (await import('node:net')).Socket();
  return new Promise<boolean>((resolve) => {
    socket.setTimeout(400);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.connect(54322, '127.0.0.1');
  });
}

export function createServiceClient(): SupabaseClient {
  return createClient(url, serviceKey!, { auth: { persistSession: false } });
}

export function createDbClient(): PgClient {
  return new PgClient({ connectionString: dbUrl });
}

export interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
}

export async function createUser(): Promise<TestUser> {
  const admin = createServiceClient();
  const email = `rls-${randomUUID()}@example.test`;
  const password = randomUUID();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('user was not created');

  const client = createClient(url, anonKey!, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  return { id: data.user.id, email, client };
}
