/**
 * Lightweight markdown renderer for AI evaluation output.
 * Handles headings, bold, bullet lists, and color-codes verdict keywords.
 * Not a full markdown spec — just what Claude's evaluation responses use.
 */

const VERDICT_COLORS = {
  STRONG: 'var(--accent)',
  STABLE: 'var(--accent2)',
  MIXED: 'var(--accent3)',
  DETERIORATING: 'var(--danger)',
  WEAK: 'var(--danger)',
}

// Matches: dollar amounts ($1,234.56 / -$500), percentages (+12.4% / -5%),
// verdict keywords, and bare large numbers (424, 1,200).
const HIGHLIGHT_RX = /(-?\$[\d,]+(?:\.\d{1,2})?|[+-]?\d[\d,]*(?:\.\d+)?%|\bSTRONG\b|\bSTABLE\b|\bMIXED\b|\bDETERIORATING\b|\bWEAK\b|\b\d[\d,]{2,}(?:\.\d+)?\b)/g

function highlightTokens(str, keyBase) {
  const parts = str.split(HIGHLIGHT_RX)
  return parts.map((p, i) => {
    if (!p) return null
    const key = `${keyBase}-${i}`
    if (VERDICT_COLORS[p]) {
      return <span key={key} style={{ color: VERDICT_COLORS[p], fontWeight: 700 }}>{p}</span>
    }
    if (/^-?\$[\d,]/.test(p)) {
      return <span key={key} className={p.startsWith('-') ? 'md-dollar md-dollar-neg' : 'md-dollar'}>{p}</span>
    }
    if (/%$/.test(p)) {
      const cls = p.startsWith('+') ? 'md-pct md-pct-pos' : p.startsWith('-') ? 'md-pct md-pct-neg' : 'md-pct'
      return <span key={key} className={cls}>{p}</span>
    }
    if (/^\d[\d,]{2,}/.test(p)) {
      return <span key={key} className="md-count">{p}</span>
    }
    return <span key={key}>{p}</span>
  })
}

function renderInline(text, keyBase) {
  // Split on **bold**
  const segments = text.split(/(\*\*[^*]+\*\*)/g)
  return segments.map((seg, i) => {
    if (seg.startsWith('**') && seg.endsWith('**')) {
      return <strong key={`${keyBase}-b${i}`}>{highlightTokens(seg.slice(2, -2), `${keyBase}-b${i}`)}</strong>
    }
    return <span key={`${keyBase}-s${i}`}>{highlightTokens(seg, `${keyBase}-s${i}`)}</span>
  })
}

export default function Markdown({ text }) {
  if (!text) return null
  const lines = String(text).split('\n')
  const blocks = []
  let listItems = []

  const flushList = () => {
    if (listItems.length) {
      blocks.push(<ul key={`ul${blocks.length}`} className="md-list">{listItems}</ul>)
      listItems = []
    }
  }

  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed) { flushList(); return }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      flushList()
      const level = heading[1].length
      const cls = level <= 1 ? 'md-h1' : level === 2 ? 'md-h2' : 'md-h3'
      blocks.push(<div key={`h${i}`} className={cls}>{renderInline(heading[2], `h${i}`)}</div>)
      return
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      listItems.push(<li key={`li${i}`}>{renderInline(bullet[1], `li${i}`)}</li>)
      return
    }

    const numbered = trimmed.match(/^(\d+)\.\s+(.*)$/)
    if (numbered) {
      listItems.push(<li key={`li${i}`} className="md-num" data-n={numbered[1]}>{renderInline(numbered[2], `li${i}`)}</li>)
      return
    }

    flushList()
    blocks.push(<p key={`p${i}`} className="md-p">{renderInline(trimmed, `p${i}`)}</p>)
  })
  flushList()

  return <div className="md">{blocks}</div>
}
