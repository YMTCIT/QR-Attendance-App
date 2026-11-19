import type { EventRow } from '../types/database'
import { formatEventDate } from '../lib/format'

interface EventSelectorProps {
  events: EventRow[]
  value: number | null
  onChange: (id: number | null) => void
  label?: string
  /** Extra leading option, e.g. "Any event". */
  emptyOption?: string
  id?: string
}

export function EventSelector({ events, value, onChange, label = 'Event', emptyOption, id = 'event-selector' }: EventSelectorProps) {
  return (
    <label className="field field--inline" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      >
        {emptyOption !== undefined && <option value="">{emptyOption}</option>}
        {emptyOption === undefined && value === null && <option value="">Select an event…</option>}
        {events.map((ev) => (
          <option key={ev.id} value={ev.id}>
            {ev.active ? '● ' : ''}
            {ev.name} — {formatEventDate(ev.date)}
            {ev.active ? ' (active)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
