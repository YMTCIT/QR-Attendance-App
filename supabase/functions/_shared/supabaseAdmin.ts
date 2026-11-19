// Deno-only: service-role Supabase client + staff auth dependencies.
// The service-role key is injected by Supabase into every Edge Function as
// SUPABASE_SERVICE_ROLE_KEY. It never reaches browsers.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { StaffAuthDeps, StaffRole } from './http.ts'

let client: SupabaseClient | null = null

export function adminClient(): SupabaseClient {
  if (client) return client
  const url = Deno.env.get('SUPABASE_URL')
  // SUPABASE_SERVICE_ROLE_KEY is injected automatically. If your project has
  // disabled legacy JWT API keys, create a secret key in the dashboard and set
  // it as SERVICE_ROLE_KEY (`supabase secrets set SERVICE_ROLE_KEY=sb_secret_...`).
  const key = Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('SUPABASE_URL / service role key are not available')
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return client
}

export function staffAuthDeps(admin: SupabaseClient): StaffAuthDeps {
  return {
    async getUserId(token) {
      // Validates the JWT with Supabase Auth (signature, expiry, user exists).
      const { data, error } = await admin.auth.getUser(token)
      if (error || !data.user) return null
      return data.user.id
    },
    async getRole(userId) {
      const { data, error } = await admin
        .from('app_user_roles')
        .select('role, disabled_at')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw error
      if (!data || data.disabled_at) return null
      return data.role as StaffRole
    },
  }
}

export function logError(message: string, error: unknown): void {
  // Logged server-side only (Supabase function logs); never returned to clients.
  console.error(`[edge] ${message}`, error instanceof Error ? error.message : error)
}
