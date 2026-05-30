// Client wrapper around the server-side Claude proxy.
//
// All requests go to /api/claude/* on the same origin — the proxy holds the
// API key, picks the model, and handles retry-on-429/529 with the upstream
// Retry-After header. The browser bundle no longer carries an API key
// (VITE_ANTHROPIC_API_KEY was removed in SEC-05).

const PROXY_URL = '/api/claude/messages'
const PROXY_PDF_URL = '/api/claude/messages/pdf'

/** Map a non-2xx fetch response to a useful Error. */
async function errorFromResponse(res) {
  if (res.status === 401) {
    // bizcoreLocked is what BizCore uses to prompt the user to re-unlock.
    let payload = {}
    try { payload = await res.json() } catch { /* ignore */ }
    const e = new Error('BizCore is locked — please unlock again.')
    e.bizcoreLocked = payload.error === 'bizcore-locked'
    return e
  }
  let body = ''
  try { body = await res.text() } catch { /* ignore */ }
  let parsed = null
  try { parsed = JSON.parse(body) } catch { /* not JSON */ }
  const msg = (parsed && parsed.error) ? parsed.error : (body.slice(0, 200) || `HTTP ${res.status}`)
  return new Error(`Claude proxy ${res.status}: ${msg}`)
}

/**
 * Call the server-side Claude proxy with a plain-text prompt.
 *
 * @param {string} prompt
 * @param {{ maxTokens?: number, system?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function callClaude(prompt, { maxTokens = 1000, system } = {}) {
  const body = {
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  }
  if (system) body.system = system
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await errorFromResponse(res)
  const data = await res.json()
  return data.content?.[0]?.text || '(no response)'
}

/**
 * Send a PDF (or other document) to Claude with a prompt and return the
 * extracted text. The proxy handles base64-ing the file and retrying on
 * rate-limit / overload, so retries are silent to the client — the UI
 * just shows a longer wait.
 *
 * @param {File} pdfFile
 * @param {string} prompt
 * @param {{ maxTokens?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function callClaudeWithPDF(pdfFile, prompt, { maxTokens = 24000 } = {}) {
  const form = new FormData()
  form.append('file', pdfFile)
  form.append('prompt', prompt)
  form.append('maxTokens', String(maxTokens))
  const res = await fetch(PROXY_PDF_URL, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  })
  if (!res.ok) throw await errorFromResponse(res)
  const data = await res.json()
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Response was truncated (hit max_tokens). The statement may have too many transactions; split into smaller files.')
  }
  return data.content?.[0]?.text || '(no response)'
}
