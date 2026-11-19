import type { ScanOutcome } from '../types/attendance'
import { describeOutcome } from '../features/attendance/checkInResult'

interface Props {
  outcome: ScanOutcome
  durationMs: number
  fallbackEventName?: string
}

/**
 * Full-screen result layer. It is rendered ON TOP of the scanner; the camera
 * component underneath stays mounted and its stream keeps running. The page
 * dismisses this automatically (no navigation, no camera restart).
 */
export function FullScreenScanResult({ outcome, durationMs, fallbackEventName }: Props) {
  const content = describeOutcome(outcome, fallbackEventName)
  const icon = content.tone === 'success' ? '✓' : content.tone === 'warning' ? '!' : '✕'

  return (
    <div className={`scan-result scan-result--${content.tone}`} role="alertdialog" aria-live="assertive" aria-label={content.title}>
      <div className="scan-result__inner">
        <div className="scan-result__icon" aria-hidden="true">
          {icon}
        </div>
        {content.kicker && <p className="scan-result__kicker">{content.kicker}</p>}
        <h1 className="scan-result__title">{content.title}</h1>
        {content.name && <p className="scan-result__name">{content.name}</p>}
        {content.lines.map((line, i) => (
          <p key={i} className={i === 0 ? 'scan-result__line scan-result__line--lead' : 'scan-result__line'}>
            {line}
          </p>
        ))}
        <p className="scan-result__brand">CIT University</p>
      </div>
      <div className="scan-result__timer" style={{ animationDuration: `${durationMs}ms` }} aria-hidden="true" />
    </div>
  )
}
