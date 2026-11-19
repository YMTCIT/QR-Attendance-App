/**
 * Short feedback tones via Web Audio (no audio files to load).
 * Browsers only allow audio after a user gesture on the page; call
 * unlockAudio() from a tap handler (the scanner's sound toggle does this).
 */
let ctx: AudioContext | null = null

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!ctx) ctx = new Ctor()
  return ctx
}

export function unlockAudio(): void {
  const c = getContext()
  if (c && c.state === 'suspended') void c.resume().catch(() => undefined)
}

function tone(freq: number, startOffset: number, duration: number, volume = 0.18): void {
  const c = getContext()
  if (!c || c.state !== 'running') return
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  const t0 = c.currentTime + startOffset
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
  osc.connect(gain).connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + duration + 0.02)
}

export function playSuccessBeep(): void {
  tone(880, 0, 0.12)
  tone(1320, 0.12, 0.16)
}

export function playWarningBeep(): void {
  tone(520, 0, 0.18)
}

export function playErrorBeep(): void {
  tone(300, 0, 0.16)
  tone(220, 0.18, 0.22)
}
