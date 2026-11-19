import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { ScannerUser } from '../../types/database'

/**
 * Scanner-account administration goes through the manage-scanner-users Edge
 * Function. The browser never touches Supabase Auth admin APIs or the
 * service-role key.
 */
async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('manage-scanner-users', { body })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      try {
        const payload = (await (error.context as Response).json()) as { error?: string }
        if (payload?.error) throw new Error(payload.error)
      } catch (inner) {
        if (inner instanceof Error && inner.message) throw inner
      }
    }
    throw new Error('Could not reach the account service. Please try again.')
  }
  return data as T
}

export async function listScannerUsers(): Promise<ScannerUser[]> {
  const res = await call<{ users: ScannerUser[] }>({ action: 'list' })
  return res.users
}

export async function createScannerUser(input: { email: string; password?: string; invite: boolean }): Promise<void> {
  await call({ action: 'create', ...input })
}

export async function setScannerDisabled(userId: string, disabled: boolean): Promise<void> {
  await call({ action: disabled ? 'disable' : 'enable', user_id: userId })
}
