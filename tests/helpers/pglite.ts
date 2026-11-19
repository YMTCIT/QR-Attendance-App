/**
 * Test harness: runs the real Supabase migrations inside PGlite (PostgreSQL
 * compiled to WebAssembly) with a minimal emulation of the Supabase pieces the
 * migrations rely on: the anon/authenticated/service_role roles, Supabase's
 * default grants, the auth schema, and auth.uid() driven by a JWT-claim GUC.
 *
 * This verifies SQL syntax, constraints, RLS and function behaviour. It is a
 * single-connection engine, so true multi-connection concurrency is covered by
 * the unique constraint + ON CONFLICT logic rather than a parallel race here.
 */
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'supabase', 'migrations')

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  grant usage on schema public to anon, authenticated, service_role;
  -- Mirror Supabase's permissive defaults so the migrations' REVOKEs matter.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

export const ADMIN_ID = '00000000-0000-0000-0000-00000000000a'
export const SCANNER_ID = '00000000-0000-0000-0000-00000000000b'
export const DISABLED_SCANNER_ID = '00000000-0000-0000-0000-00000000000c'
export const NO_ROLE_ID = '00000000-0000-0000-0000-00000000000d'

export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(SUPABASE_STUB)

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      await db.exec(sql)
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error })
    }
  }

  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN_ID}', 'admin@example.test'),
      ('${SCANNER_ID}', 'scanner@example.test'),
      ('${DISABLED_SCANNER_ID}', 'disabled@example.test'),
      ('${NO_ROLE_ID}', 'nobody@example.test');
    insert into public.app_user_roles (user_id, role, disabled_at) values
      ('${ADMIN_ID}', 'admin', null),
      ('${SCANNER_ID}', 'scanner', null),
      ('${DISABLED_SCANNER_ID}', 'scanner', now());
  `)
  return db
}

type Who = 'postgres' | 'anon' | 'service_role' | { userId: string }

/** Run `fn` as a given database role / signed-in user inside a transaction. */
export async function as<T>(db: PGlite, who: Who, fn: (tx: Pick<PGlite, 'query' | 'exec'>) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (who === 'anon') {
      await tx.exec(`set local role anon`)
    } else if (who === 'service_role') {
      await tx.exec(`set local role service_role`)
    } else if (typeof who === 'object') {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.userId])
      await tx.exec(`set local role authenticated`)
    }
    return fn(tx)
  })
}
