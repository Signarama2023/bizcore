import { reminderFor } from '../utils/reminders'

/**
 * Small freshness pill for a manual-upload area — green = recent, amber = due
 * for a refresh, red = overdue. Renders nothing if the source has never been
 * uploaded (the card's own empty state already covers that case).
 *
 * @param {{ reminderKey: string }} props  a reminders.js source key,
 *   e.g. 'arAging', 'completedSales', 'bank.opex'.
 */
export default function FreshnessBadge({ reminderKey }) {
  const r = reminderFor(reminderKey)
  if (!r || r.status.state === 'never') return null
  return (
    <span
      className={`pill ${r.status.pill}`}
      style={{ fontSize: 10 }}
      title={`Last refreshed ${r.status.label} · suggested cadence: every ${r.cadenceDays} days`}
    >
      {r.status.label}
    </span>
  )
}
