// Supabase Edge Function: register-attendee
// Webhook for Microsoft Forms → Power Automate. Authenticated with a shared
// secret (REGISTRATION_WEBHOOK_SECRET) sent in the x-registration-secret
// header — NOT with a user JWT, so this function is deployed with
// verify_jwt = false (see supabase/config.toml). It upserts on qr_code, so
// Power Automate retries never create duplicate registrations.
// This function never generates QR codes and never records attendance.
import { MAX_BODY_BYTES, SECRET_HEADER, handleRegister } from '../_shared/registerCore.ts'
import { corsHeaders, jsonResponse } from '../_shared/http.ts'
import { adminClient, logError } from '../_shared/supabaseAdmin.ts'

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('Origin'), Deno.env.get('ALLOWED_ORIGINS'))
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    let body: unknown = null
    if (req.method === 'POST') {
      const text = await req.text()
      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
        return jsonResponse({ error: 'payload_too_large' }, 413, cors)
      }
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        return jsonResponse({ error: 'invalid_json' }, 400, cors)
      }
    }

    const result = await handleRegister(
      { method: req.method, providedSecret: req.headers.get(SECRET_HEADER), body },
      {
        secret: Deno.env.get('REGISTRATION_WEBHOOK_SECRET'),
        async upsert(p) {
          const { data, error } = await adminClient().rpc('integration_upsert_registrant', {
            p_qr_code: p.qr_code,
            p_name: p.name,
            p_id_number: p.id_number,
            p_email: p.email,
            p_department: p.department,
            p_event_id: p.event_id,
          })
          if (error) throw error
          return data as { status: string; id?: number; created?: boolean }
        },
        logError,
      },
    )
    return jsonResponse(result.body, result.status, cors)
  } catch (error) {
    logError('register-attendee unhandled error', error)
    return jsonResponse({ error: 'server_error' }, 500, cors)
  }
})
