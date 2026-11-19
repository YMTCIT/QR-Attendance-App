// Supabase Edge Function: check-in
// Records a QR check-in for the ACTIVE event. Callable by signed-in staff
// (admin or scanner). The browser sends ONLY the decoded QR text.
import { handleCheckIn } from '../_shared/checkInCore.ts'
import { corsHeaders, jsonResponse } from '../_shared/http.ts'
import { adminClient, logError, staffAuthDeps } from '../_shared/supabaseAdmin.ts'

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('Origin'), Deno.env.get('ALLOWED_ORIGINS'))
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const admin = adminClient()
    let body: unknown = null
    if (req.method === 'POST') {
      const text = await req.text()
      if (text.length > 4096) return jsonResponse({ error: 'bad_request' }, 400, cors)
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        return jsonResponse({ error: 'bad_request' }, 400, cors)
      }
    }

    const result = await handleCheckIn(
      { method: req.method, authorization: req.headers.get('Authorization'), body },
      {
        ...staffAuthDeps(admin),
        async recordCheckIn(qrCode, userId) {
          const { data, error } = await admin.rpc('record_qr_check_in', {
            p_qr_code: qrCode,
            p_recorded_by: userId,
          })
          if (error) throw error
          return data
        },
        logError,
      },
    )
    return jsonResponse(result.body, result.status, cors)
  } catch (error) {
    logError('check-in unhandled error', error)
    return jsonResponse({ error: 'server_error' }, 500, cors)
  }
})
