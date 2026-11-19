// Supabase Edge Function: manage-scanner-users
// Admin-only provisioning of scanner (event staff) accounts. Uses the Auth
// admin API with the service role, which must never be exposed to browsers.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { handleScannerUsers, type ScannerUserView } from '../_shared/scannerUsersCore.ts'
import { corsHeaders, jsonResponse, type StaffRole } from '../_shared/http.ts'
import { adminClient, logError, staffAuthDeps } from '../_shared/supabaseAdmin.ts'

// "Disabled" = role row has disabled_at AND the auth user is banned (blocks
// sign-in and token refresh). The role check blocks requests immediately.
const BAN_FOREVER = '876000h' // ~100 years

async function listScanners(admin: SupabaseClient): Promise<ScannerUserView[]> {
  const { data, error } = await admin
    .from('app_user_roles')
    .select('user_id, role, disabled_at, created_at')
    .eq('role', 'scanner')
    .order('created_at', { ascending: true })
  if (error) throw error
  const rows = (data ?? []) as { user_id: string; disabled_at: string | null; created_at: string }[]
  return Promise.all(
    rows.map(async (r) => {
      const { data: u } = await admin.auth.admin.getUserById(r.user_id)
      return {
        user_id: r.user_id,
        email: u?.user?.email ?? null,
        role: 'scanner' as const,
        disabled: !!r.disabled_at,
        created_at: r.created_at,
        last_sign_in_at: u?.user?.last_sign_in_at ?? null,
      }
    }),
  )
}

async function createScanner(
  admin: SupabaseClient,
  input: { email: string; password: string | null; invite: boolean },
): Promise<void> {
  const created = input.invite
    ? await admin.auth.admin.inviteUserByEmail(input.email, {
        redirectTo: Deno.env.get('SITE_URL') ? `${Deno.env.get('SITE_URL')}/login` : undefined,
      })
    : await admin.auth.admin.createUser({ email: input.email, password: input.password ?? undefined, email_confirm: true })

  if (created.error || !created.data.user) {
    const msg = created.error?.message ?? ''
    if (/already|exists|registered/i.test(msg)) throw new Error('exists')
    throw created.error ?? new Error('createUser returned no user')
  }

  const userId = created.data.user.id
  const { error } = await admin.from('app_user_roles').insert({ user_id: userId, role: 'scanner' })
  if (error) {
    // Roll back the auth user so we never leave an account without a role.
    await admin.auth.admin.deleteUser(userId)
    throw error
  }
}

async function setDisabled(admin: SupabaseClient, userId: string, disabled: boolean): Promise<void> {
  const { error } = await admin
    .from('app_user_roles')
    .update({ disabled_at: disabled ? new Date().toISOString() : null })
    .eq('user_id', userId)
    .eq('role', 'scanner')
  if (error) throw error
  const { error: banError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: disabled ? BAN_FOREVER : 'none',
  })
  if (banError) throw banError
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('Origin'), Deno.env.get('ALLOWED_ORIGINS'))
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const admin = adminClient()
    let body: unknown = null
    if (req.method === 'POST') {
      try {
        body = await req.json()
      } catch {
        return jsonResponse({ error: 'Invalid request.' }, 400, cors)
      }
    }

    const result = await handleScannerUsers(
      { method: req.method, authorization: req.headers.get('Authorization'), body },
      {
        ...staffAuthDeps(admin),
        listScanners: () => listScanners(admin),
        async getStoredRole(userId) {
          const { data, error } = await admin.from('app_user_roles').select('role').eq('user_id', userId).maybeSingle()
          if (error) throw error
          return (data?.role as StaffRole | undefined) ?? null
        },
        createScanner: (input) => createScanner(admin, input),
        setDisabled: (userId, disabled) => setDisabled(admin, userId, disabled),
        logError,
      },
    )
    return jsonResponse(result.body, result.status, cors)
  } catch (error) {
    logError('manage-scanner-users unhandled error', error)
    return jsonResponse({ error: 'server_error' }, 500, cors)
  }
})
