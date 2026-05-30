import { useState } from 'react'
import { callClaude } from '../utils/claude'
import {
  buildEvaluationPrompt,
  listEvaluationSources,
  countSelected,
  extractDigDeeperNotes,
  parseEvaluationSections,
  extractVerdict,
} from '../utils/evaluation'
import EvaluationCharts, { DebtKpiBar, PayrollKpiBar } from '../components/EvaluationCharts'
import Markdown from '../components/Markdown'

const RESULT_KEY = 'bizcore.evaluation.latest'
const SELECTION_KEY = 'bizcore.evaluation.selection'

// Verdict word → color + plain-language meaning, so the headline reads at a glance.
const VERDICT_META = {
  STRONG: { color: 'var(--accent)', gloss: 'The business is in good shape.' },
  STABLE: { color: 'var(--accent2)', gloss: 'Holding steady — nothing on fire.' },
  MIXED: { color: 'var(--accent3)', gloss: 'Bright spots and real concerns both.' },
  DETERIORATING: { color: 'var(--danger)', gloss: 'Trending the wrong way — act now.' },
  WEAK: { color: 'var(--danger)', gloss: 'Needs attention soon.' },
}

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// Default: exclude Weekly Log; everything else included (missing key = included).
function loadSelection() {
  return loadJSON(SELECTION_KEY) || { weekly: false }
}

export default function Evaluation({ theme = 'light' }) {
  const [analysis, setAnalysis] = useState(() => loadJSON(RESULT_KEY))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState(loadSelection)
  // Collapse the document picker once a result exists, so the page leads
  // with the verdict instead of a long checklist.
  const [sourcesOpen, setSourcesOpen] = useState(() => !loadJSON(RESULT_KEY))

  const sources = listEvaluationSources()
  const counts = countSelected(selection)

  function toggleSource(key) {
    setSelection((prev) => {
      const isOn = prev[key] !== false
      const next = { ...prev, [key]: !isOn }
      try { localStorage.setItem(SELECTION_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  function setGroup(groupName, value) {
    setSelection((prev) => {
      const next = { ...prev }
      for (const s of sources) {
        if (s.group === groupName) next[s.key] = value
      }
      try { localStorage.setItem(SELECTION_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  async function runEvaluation() {
    setLoading(true)
    setError('')
    try {
      const prompt = await buildEvaluationPrompt(selection)
      if (!prompt) {
        throw new Error('No sources selected. Check at least one document below.')
      }
      const result = await callClaude(prompt, { maxTokens: 3000 })
      const evaluation = {
        timestamp: new Date().toISOString(),
        result,
        sourceCount: counts.selected,
      }
      setAnalysis(evaluation)
      setSourcesOpen(false)
      try { localStorage.setItem(RESULT_KEY, JSON.stringify(evaluation)) } catch {}
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function clearEvaluation() {
    if (!window.confirm('Clear the last AI evaluation?')) return
    setAnalysis(null)
    setSourcesOpen(true)
    try { localStorage.removeItem(RESULT_KEY) } catch {}
  }

  // Group sources for display
  const groups = []
  for (const s of sources) {
    let g = groups.find((x) => x.name === s.group)
    if (!g) { g = { name: s.group, items: [] }; groups.push(g) }
    g.items.push(s)
  }

  return (
    <div>
      <h1 className="page-title">Evaluation</h1>
      <p className="page-subtitle">
        A full AI read on the business. Pick the data to include, run it, and you get a
        one-word verdict, an action plan, and the supporting detail.
      </p>

      {/* ---- Step 1: choose data + run ---- */}
      <div className="card">
        <div className="row between" style={{ marginBottom: sourcesOpen ? 12 : 0 }}>
          <div>
            <div className="section-label">Step 1 · Data to evaluate</div>
            <div className="dim" style={{ fontSize: 12 }}>
              {counts.selected} of {counts.total} sources selected.
              {sources.length > 0 && (
                <button
                  onClick={() => setSourcesOpen((v) => !v)}
                  style={{
                    background: 'transparent', border: 0, color: 'var(--accent2)',
                    cursor: 'pointer', font: 'inherit', fontSize: 12, padding: '0 0 0 6px',
                    textDecoration: 'underline',
                  }}
                >
                  {sourcesOpen ? 'hide' : 'choose sources'}
                </button>
              )}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn-primary"
              onClick={runEvaluation}
              disabled={loading || counts.selected === 0}
            >
              {loading ? 'Analyzing…' : analysis ? 'Re-run Evaluation' : 'Run Full Evaluation'}
            </button>
            {analysis && (
              <button className="btn-danger" onClick={clearEvaluation} title="Clear the last AI evaluation">
                Clear
              </button>
            )}
          </div>
        </div>

        {sourcesOpen && (
          sources.length === 0 ? (
            <p className="dim" style={{ fontSize: 13 }}>
              No data loaded yet. Import on the Finance and Pipeline pages first.
            </p>
          ) : (
            groups.map((g) => {
              const all = g.items.every((it) => selection[it.key] !== false)
              const none = g.items.every((it) => selection[it.key] === false)
              return (
                <div key={g.name} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
                  <div className="row between" style={{ marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{g.name}</span>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="btn-outline"
                        style={{ fontSize: 10, padding: '2px 8px' }}
                        onClick={() => setGroup(g.name, true)}
                        disabled={all}
                      >
                        all
                      </button>
                      <button
                        className="btn-outline"
                        style={{ fontSize: 10, padding: '2px 8px' }}
                        onClick={() => setGroup(g.name, false)}
                        disabled={none}
                      >
                        none
                      </button>
                    </div>
                  </div>
                  {g.items.map((it) => {
                    const checked = selection[it.key] !== false
                    return (
                      <label
                        key={it.key}
                        className="row"
                        style={{ gap: 10, padding: '5px 0', cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSource(it.key)}
                          style={{ accentColor: 'var(--accent2)', width: 15, height: 15 }}
                        />
                        <span style={{ flex: 1, color: checked ? 'var(--text)' : 'var(--muted)' }}>{it.label}</span>
                        <span className="dim mono" style={{ fontSize: 11 }}>{it.detail}</span>
                      </label>
                    )
                  })}
                </div>
              )
            })
          )
        )}
      </div>

      {error && (
        <div className="card" style={{ marginTop: 16, borderColor: 'var(--danger)' }}>
          <span className="pill red">Error</span>
          <span style={{ marginLeft: 8 }}>{error}</span>
        </div>
      )}

      {analysis && <EvaluationResult analysis={analysis} />}

      {/* DEBT-06: snapshot strip — outstanding, debt service MTD, debt/revenue.
          Hides itself if /api/debts/summary has no active debts and no
          historical payments, so debt-free businesses don't see an empty card. */}
      <DebtKpiBar />

      {/* PAY-05: payroll snapshot — total YTD, MTD, payroll-to-revenue ratio.
          Hides itself if Gusto isn't configured + no historical payroll runs,
          so the same hide-when-empty discipline applies. */}
      <PayrollKpiBar />

      <div className="section-label" style={{ marginTop: 24 }}>
        {analysis ? 'Supporting charts' : 'Your data so far'}
      </div>
      <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
        Trends pulled straight from your imports — no AI run needed.
      </div>
      <EvaluationCharts theme={theme} />
    </div>
  )
}

/**
 * Structured render of an evaluation: verdict hero → action plan →
 * dig-deeper notes → collapsible detail. Falls back to a plain markdown
 * card if the response didn't parse into the expected sections.
 */
function EvaluationResult({ analysis }) {
  const sections = parseEvaluationSections(analysis.result)
  const verdict = extractVerdict(analysis.result)
  const notes = extractDigDeeperNotes(analysis.result)
  const generated = `${analysis.timestamp.slice(0, 10)} at ${analysis.timestamp.slice(11, 16)}`

  const byNum = (n) => sections.find((s) => s.num === n)
  const verdictSec = byNum(1) || sections.find((s) => /verdict|executive/i.test(s.title))
  const actionsSec = byNum(7) || sections.find((s) => /action/i.test(s.title))
  const watchSec = byNum(8) || sections.find((s) => /watch/i.test(s.title))

  // Anything left over (Cash, Revenue, Operations, AR, Cross-check…) is detail.
  const used = new Set([verdictSec, actionsSec, watchSec].filter(Boolean))
  const detailSecs = sections.filter(
    (s) => !used.has(s) && !/dig deeper/i.test(s.title)
  )

  // Couldn't parse the expected shape — show the raw evaluation rather than
  // dropping content.
  if (!sections.length || !verdictSec) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <div>
            <div className="section-label">AI Evaluation</div>
            <div className="dim" style={{ fontSize: 12 }}>Generated {generated} · {analysis.sourceCount} sources</div>
          </div>
          <span className="source-badge corebridge">Claude · Sonnet 4.6</span>
        </div>
        <Markdown text={analysis.result} />
      </div>
    )
  }

  const vMeta = (verdict && VERDICT_META[verdict]) || { color: 'var(--accent2)', gloss: '' }

  return (
    <>
      {/* Verdict hero — the headline */}
      <div
        className="card"
        style={{ marginTop: 16, borderLeft: `5px solid ${vMeta.color}` }}
      >
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
              Overall verdict
            </div>
            {verdict ? (
              <div style={{ fontFamily: 'var(--font-display, serif)', fontSize: 36, color: vMeta.color, lineHeight: 1.1 }}>
                {verdict}
              </div>
            ) : (
              <div style={{ fontFamily: 'var(--font-display, serif)', fontSize: 24 }}>{verdictSec.title}</div>
            )}
            {vMeta.gloss && (
              <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>{vMeta.gloss}</div>
            )}
          </div>
          <span className="dim" style={{ fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap' }}>
            {generated}<br />{analysis.sourceCount} sources
          </span>
        </div>
        <div style={{ marginTop: 10 }}>
          <Markdown text={verdictSec.body} />
        </div>
      </div>

      {/* Action plan — what to actually do */}
      {(actionsSec || watchSec || notes.length > 0) && (
        <div className="grid-2" style={{ marginTop: 16, gap: 16 }}>
          {actionsSec && (
            <div className="card" style={{ borderLeft: '4px solid var(--accent)' }}>
              <div className="section-label" style={{ color: 'var(--accent)' }}>Do this next</div>
              <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
                Prioritized moves for the next 30 days.
              </div>
              <Markdown text={actionsSec.body} />
            </div>
          )}
          {watchSec && (
            <div className="card" style={{ borderLeft: '4px solid var(--accent3)' }}>
              <div className="section-label" style={{ color: 'var(--accent3)' }}>Keep an eye on</div>
              <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
                Metrics to track week over week.
              </div>
              <Markdown text={watchSec.body} />
            </div>
          )}
        </div>
      )}

      {/* Dig-deeper notes — anomalies worth a closer look */}
      {notes.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row between" style={{ marginBottom: 12 }}>
            <div>
              <div className="section-label">Notes to dig into</div>
              <div className="dim" style={{ fontSize: 12 }}>
                Anomalies and open questions Claude surfaced. Each is worth a closer look.
              </div>
            </div>
            <span className="source-badge corebridge">{notes.length} items</span>
          </div>
          <div className="grid-2" style={{ gap: 12 }}>
            {notes.map((n, i) => (
              <div key={i} className="card-sm" style={{ background: 'var(--bg3)', borderLeft: '3px solid var(--accent3)' }}>
                {n.label && (
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: 'var(--accent3)' }}>{n.label}</div>
                )}
                <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text)' }}>{n.note}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The detail — collapsed by default so the page leads with the answer */}
      {detailSecs.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="section-label">The detail behind it</div>
          <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
            Click any area to expand the full breakdown.
          </div>
          {detailSecs.map((s, i) => (
            <details key={i} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
                {s.title}
              </summary>
              <div style={{ marginTop: 8 }}>
                <Markdown text={s.body} />
              </div>
            </details>
          ))}
        </div>
      )}
    </>
  )
}
