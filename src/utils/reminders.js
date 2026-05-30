/**
 * Reminder system — tracks how stale each upload is across BizCore.
 * Pulls timestamps from the existing localStorage keys, no new state.
 */

const REMINDER_DEFS = [
  { key: 'newlyCreated', storageKey: 'bizcore.pipeline.newlyCreated', label: 'Newly Created Sales', cadenceDays: 7, source: 'pipeline' },
  { key: 'completedSales', storageKey: 'bizcore.pipeline.completedSales', label: 'Completed Sales', cadenceDays: 7, source: 'pipeline' },
  { key: 'closedSales', storageKey: 'bizcore.pipeline.closedSales', label: 'Closed Sales (Paid)', cadenceDays: 7, source: 'pipeline' },
  { key: 'wip', storageKey: 'bizcore.pipeline.wip', label: 'Work In Progress', cadenceDays: 7, source: 'pipeline' },
  { key: 'arAging', storageKey: 'bizcore.pipeline.arAging', label: 'AR Aging', cadenceDays: 7, source: 'pipeline' },
  { key: 'bank.income', storageKey: 'bizcore.bank.income', label: 'Income (7068) statement', cadenceDays: 30, source: 'bank' },
  { key: 'bank.opex', storageKey: 'bizcore.bank.opex', label: 'Opex (7076) statement', cadenceDays: 30, source: 'bank' },
  { key: 'bank.owners', storageKey: 'bizcore.bank.owners', label: 'Owners (7092) statement', cadenceDays: 30, source: 'bank' },
  { key: 'bank.profit', storageKey: 'bizcore.bank.profit', label: 'Profit (7100) statement', cadenceDays: 30, source: 'bank' },
  { key: 'bank.tax', storageKey: 'bizcore.bank.tax', label: 'Tax (7118) statement', cadenceDays: 30, source: 'bank' },
  { key: 'bank.amex', storageKey: 'bizcore.bank.amex', label: 'AMEX statement', cadenceDays: 30, source: 'bank' },
]

const LAST_NOTIFY_KEY = 'bizcore.reminders.lastNotified'

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function lastTimestampFor(def) {
  const data = loadJSON(def.storageKey)
  if (!Array.isArray(data) || data.length === 0) return null
  if (def.source === 'pipeline' || def.source === 'bank') return data[0]?.uploadedAt || null
  return null
}

function daysSince(iso) {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null
  // Compare calendar dates (local time) — ignore time of day so an upload
  // "yesterday afternoon" reads as 1 day, not 0, when viewed this morning.
  const thenDay = new Date(then.getFullYear(), then.getMonth(), then.getDate())
  const nowDate = new Date()
  const nowDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate())
  return Math.round((nowDay - thenDay) / 86400000)
}

function ago(days) {
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

function statusFor(days, cadenceDays) {
  if (days == null) return { state: 'never', label: 'never uploaded', pill: 'red' }
  if (days >= cadenceDays + 7) return { state: 'overdue', label: `${ago(days)} — long overdue`, pill: 'red' }
  if (days >= cadenceDays) return { state: 'due', label: `${ago(days)} — due now`, pill: 'yellow' }
  return { state: 'recent', label: ago(days), pill: 'green' }
}

export function computeReminders() {
  return REMINDER_DEFS.map((def) => {
    const last = lastTimestampFor(def)
    const days = daysSince(last)
    const status = statusFor(days, def.cadenceDays)
    return { ...def, last, days, status }
  })
}

export function getActionableReminders() {
  return computeReminders().filter((r) => r.status.state !== 'recent')
}

/** The single reminder entry for one source key, or null if unknown. */
export function reminderFor(key) {
  return computeReminders().find((r) => r.key === key) || null
}

export function browserNotificationsAvailable() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function browserNotificationsPermission() {
  return browserNotificationsAvailable() ? Notification.permission : 'unsupported'
}

export async function requestBrowserNotifications() {
  if (!browserNotificationsAvailable()) return 'unsupported'
  return Notification.requestPermission()
}

/**
 * Fire a single browser notification for any due/overdue items.
 * Throttled to once per 24h via localStorage so it isn't spammy.
 */
export function fireReminderNotification({ force = false } = {}) {
  if (!browserNotificationsAvailable()) return false
  if (Notification.permission !== 'granted') return false
  if (!force) {
    const last = localStorage.getItem(LAST_NOTIFY_KEY)
    if (last && Date.now() - new Date(last).getTime() < 24 * 60 * 60 * 1000) return false
  }
  const actionable = getActionableReminders()
  if (actionable.length === 0) return false
  const body = actionable.map((r) => `• ${r.label}`).join('\n')
  new Notification('BizCore — upload reminders', {
    body,
    icon: '/favicon.svg',
  })
  localStorage.setItem(LAST_NOTIFY_KEY, new Date().toISOString())
  return true
}
