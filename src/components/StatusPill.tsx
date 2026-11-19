type Tone = 'ok' | 'warn' | 'bad' | 'neutral'

export function StatusPill({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      <span className="pill__dot" aria-hidden="true" />
      {label}
    </span>
  )
}
