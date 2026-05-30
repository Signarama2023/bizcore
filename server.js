/**
 * BizCore standalone server.
 *
 * - HTTP Basic Auth gate on everything (single ADMIN_PASSWORD env var).
 * - Reverse-proxies /api/* to team-calendar, authenticating as a real admin
 *   user via TC_USER_EMAIL + TC_USER_PASSWORD. The session cookie is held
 *   in memory and re-acquired automatically on 401.
 * - Serves the built React app from ./dist with an SPA fallback.
 *
 * No team-calendar code changes are required for this to work.
 *
 * Env vars:
 *   ADMIN_PASSWORD     Required in prod. Basic Auth password for "admin".
 *   ADMIN_USER         Optional, defaults to "admin".
 *   TEAM_CALENDAR_URL  Origin of team-calendar (no trailing slash).
 *                      e.g. https://signarama-temecula-calendar.onrender.com
 *   TC_USER_EMAIL      Email of an ADMIN user on team-calendar.
 *   TC_USER_PASSWORD   That user's password.
 *   PORT               Defaults to 3001 locally, 10000 on Render.
 */

import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { createProxyMiddleware } from 'http-proxy-middleware'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = process.env.PORT || 3001
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const TEAM_CALENDAR_URL = (process.env.TEAM_CALENDAR_URL || 'http://localhost:3000').replace(/\/$/, '')
const TC_USER_EMAIL = process.env.TC_USER_EMAIL || ''
const TC_USER_PASSWORD = process.env.TC_USER_PASSWORD || ''

// team-calendar session cookie held in memory. Re-acquired on 401.
let sessionCookie = ''
let loginInFlight = null

async function loginToTC() {
  if (!TC_USER_EMAIL || !TC_USER_PASSWORD) return false
  if (loginInFlight) return loginInFlight
  loginInFlight = (async () => {
    try {
      const r = await fetch(`${TEAM_CALENDAR_URL}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: TC_USER_EMAIL, password: TC_USER_PASSWORD }),
      })
      if (!r.ok) {
        console.error(`team-calendar login failed: HTTP ${r.status}`)
        return false
      }
      const setCookie = r.headers.get('set-cookie') || ''
      const m = setCookie.match(/tc_session=[^;]+/)
      if (m) {
        sessionCookie = m[0]
        console.log('team-calendar login OK')
        return true
      }
      console.error('team-calendar login response had no tc_session cookie')
      return false
    } catch (err) {
      console.error('team-calendar login error:', err.message)
      return false
    } finally {
      loginInFlight = null
    }
  })()
  return loginInFlight
}

const app = express()

// Render health check — unauthenticated.
app.get('/health', (req, res) => res.json({ ok: true }))

// ---------- HTTP Basic Auth ----------
function authChallenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="BizCore"').status(401).end()
}
app.use((req, res, next) => {
  if (!ADMIN_PASSWORD) return next() // local-dev open mode
  const header = req.headers.authorization || ''
  if (!header.startsWith('Basic ')) return authChallenge(res)
  const decoded = Buffer.from(header.slice(6), 'base64').toString()
  const idx = decoded.indexOf(':')
  const user = idx < 0 ? '' : decoded.slice(0, idx)
  const pass = idx < 0 ? '' : decoded.slice(idx + 1)
  if (user !== ADMIN_USER || pass !== ADMIN_PASSWORD) return authChallenge(res)
  next()
})

// "Lock BizCore" — challenge the browser so it discards cached Basic creds.
app.post('/api/bizcore/logout', (req, res) => authChallenge(res))

// ---------- Reverse proxy /api/* → team-calendar ----------
app.use('/api', createProxyMiddleware({
  target: TEAM_CALENDAR_URL,
  changeOrigin: true,
  xfwd: true,
  on: {
    proxyReq: (proxyReq) => {
      if (sessionCookie) proxyReq.setHeader('Cookie', sessionCookie)
    },
    proxyRes: (proxyRes) => {
      // team-calendar returned 401 → our session expired. Re-login in the
      // background; the next request from the client will pick up the new
      // cookie. The current request still gets the 401, prompting a retry.
      if (proxyRes.statusCode === 401) {
        loginToTC().catch(() => {})
      }
    },
    error: (err, req, res) => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'team-calendar unreachable', detail: err.message })
      }
    },
  },
}))

// ---------- Static React app + SPA fallback ----------
const distDir = path.join(__dirname, 'dist')
app.use(express.static(distDir))
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`BizCore listening on http://localhost:${PORT}`)
  if (!ADMIN_PASSWORD) console.log('⚠  ADMIN_PASSWORD not set — running open (local dev only).')
  console.log(`  /api/* → ${TEAM_CALENDAR_URL}`)
  if (TC_USER_EMAIL && TC_USER_PASSWORD) {
    await loginToTC()
  } else {
    console.log('  (TC_USER_EMAIL / TC_USER_PASSWORD not set — proxied requests will be unauthenticated)')
  }
})
