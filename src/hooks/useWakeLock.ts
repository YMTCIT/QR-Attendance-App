import { useEffect, useState } from 'react'

type WakeLockStatus = 'unsupported' | 'active' | 'released' | 'error'

interface WakeLockSentinelLike {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', cb: () => void) => void
}

/**
 * Keeps the tablet screen awake while the scanner is open (Screen Wake Lock
 * API). The browser releases the lock whenever the page is hidden, so it is
 * re-acquired when the page becomes visible again.
 */
export function useWakeLock(enabled = true): WakeLockStatus {
  const [status, setStatus] = useState<WakeLockStatus>(() =>
    typeof navigator !== 'undefined' && 'wakeLock' in navigator ? 'released' : 'unsupported',
  )

  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
    const wakeLock = (navigator as Navigator & { wakeLock: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } })
      .wakeLock
    let sentinel: WakeLockSentinelLike | null = null
    let disposed = false

    const acquire = async () => {
      if (disposed || document.visibilityState !== 'visible') return
      if (sentinel && !sentinel.released) return
      try {
        sentinel = await wakeLock.request('screen')
        if (disposed) {
          await sentinel.release()
          return
        }
        setStatus('active')
        sentinel.addEventListener('release', () => {
          if (!disposed) setStatus('released')
        })
      } catch {
        if (!disposed) setStatus('error')
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {})
    }
  }, [enabled])

  return status
}
