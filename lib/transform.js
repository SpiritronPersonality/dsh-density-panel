/**
 * Pure text transforms for the density shadow / entry compressor.
 * No Cordis, no I/O: every function takes text and returns text.
 */

const SCALAR_TYPES = new Set(['string', 'number', 'boolean'])

function isScalar(v) {
  return v === null || SCALAR_TYPES.has(typeof v)
}

function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : String(v)
  return /[",\n\r]/.test(s) ? JSON.stringify(s) : s
}

function rowsToCsv(rows, keys) {
  const lines = [keys.join(',')]
  for (const row of rows) lines.push(keys.map(k => csvCell(row[k])).join(','))
  return lines.join('\n')
}


/** Strip read-tool gutters from every line when the text is gutter-prefixed. */
function ungutter(text) {
  const lines = text.split('\n')
  const nonEmpty = lines.filter(line => line.trim())
  if (!nonEmpty.length) return text
  const prefixed = nonEmpty.filter(line => /^\s*\d+:\s/.test(line)).length
  if (prefixed / nonEmpty.length < 0.8) return text
  return lines.map(line => stripGutter(line)).join('\n')
}

export function jsonArrayCsv(text) {
  const t = ungutter(text).trim()
  if (t.length < 120 || t.length > 500000) return null
  if (t[0] !== '[' || t[t.length - 1] !== ']') return null
  let arr
  try {
    arr = JSON.parse(t)
  } catch {
    return null
  }
  if (!Array.isArray(arr) || arr.length < 5 || arr.length > 5000) return null
  if (!arr.every(x => x && typeof x === 'object' && !Array.isArray(x))) return null
  const keys = Object.keys(arr[0])
  if (keys.length < 2 || keys.length > 40) return null
  for (const row of arr) {
    const rowKeys = Object.keys(row)
    if (rowKeys.length !== keys.length) return null
    for (const k of rowKeys) {
      if (!keys.includes(k) || !isScalar(row[k])) return null
    }
  }
  return { method: 'toon', lossy: false, text: rowsToCsv(arr, keys) }
}

export function jsonlCsv(text) {
  const lines = ungutter(text).split('\n').filter(line => line.trim())
  if (lines.length < 6 || lines.length > 5000) return null
  const rows = []
  let keys = null
  for (const line of lines) {
    let value
    try {
      value = JSON.parse(line)
    } catch {
      return null
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const rowKeys = Object.keys(value)
    if (!keys) keys = rowKeys
    else if (rowKeys.length !== keys.length || !rowKeys.every(k => keys.includes(k))) return null
    for (const k of rowKeys) if (!isScalar(value[k])) return null
    rows.push(value)
  }
  if (!keys || keys.length < 2) return null
  return { method: 'jsonl', lossy: false, text: rowsToCsv(rows, keys) }
}

function numeric(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback
}

/**
 * Row budgets arrive two ways: `compressText` passes the whole options object as
 * the second argument, while tests and callers pass plain numbers. Accept both,
 * otherwise the head budget becomes an object (→ NaN lines, empty head).
 */
function rowBudget(headArg, tailArg, defaults) {
  if (headArg && typeof headArg === 'object') {
    const head = headArg.headLines ?? headArg.headRows
    const tail = headArg.tailLines ?? headArg.tailRows
    return [numeric(head, defaults[0]), numeric(tail, defaults[1])]
  }
  return [numeric(headArg, defaults[0]), numeric(tailArg, defaults[1])]
}

function takeTail(list, count) {
  return count > 0 ? list.slice(-count) : []
}

export function tableSample(text, headRowsArg = 6, tailRowsArg = 2) {
  text = ungutter(text)
  const [headRows, tailRows] = rowBudget(headRowsArg, tailRowsArg, [6, 2])
  const lines = text.split('\n')
  if (lines.length < 10) return null
  const pipe = lines.filter(line => (line.match(/\|/g) || []).length >= 2)
  if (pipe.length < 8 || pipe.length < lines.length * 0.6) return null
  // The separator row (`|---|`) is the table header marker; without it this is
  // probably log text that happens to contain pipes.
  const sep = pipe.findIndex(line => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line))
  if (sep < 0 || sep > 2) return null
  const head = pipe.slice(0, Math.max(sep + 1, headRows))
  const tail = takeTail(pipe, tailRows)
  const omitted = pipe.length - head.length - tail.length
  if (omitted < 3) return null
  return {
    method: 'table',
    lossy: true,
    text: `${head.join('\n')}\n… ${omitted} 行省略（共 ${pipe.length} 行，保留表头与首尾）…\n${tail.join('\n')}`,
  }
}

export function diffContext(text) {
  const lines = text.split('\n')
  if (lines.length < 12) return null
  if (!/^(diff --git |--- a\/|@@ )/m.test(text)) return null
  const kept = []
  let dropped = 0
  let changed = 0
  for (const line of lines) {
    if (/^(diff --git |index |--- |\+\+\+ |@@ |old mode|new mode|rename |similarity )/.test(line)) {
      kept.push(line)
      continue
    }
    if (/^[+-]/.test(line)) {
      if (line.trim() !== '---' && line.trim() !== '+++') changed++
      kept.push(line)
      continue
    }
    if (/^ /.test(line)) {
      dropped++
      continue
    }
    kept.push(line)
  }
  if (dropped < 6 || changed < 2) return null
  const head = kept.slice(0, 160)
  const more = kept.length > head.length ? [`… 省略 ${kept.length - head.length} 行变更 …`] : []
  return {
    method: 'diff',
    lossy: true,
    text: [...head, ...more, `… 省略 ${dropped} 行未变更上下文 …`].join('\n'),
  }
}

/** A line that carries a timestamp, a level tag, or a key=value log prefix. */
const LOG_SHAPE_RE =
  /^(?:\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}|\s*\[?\d{1,2}:\d{2}:\d{2}|\s*(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL)\b|\s*\[(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL)\]|\s*[A-Za-z0-9_.-]+\s+\|\s*(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL)\b)/i

/**
 * Log sampling is only honest for log-shaped text. Prose and source code contain
 * the words "error"/"failed" too; without this guard they get sampled as if they
 * were logs, which keeps arbitrary lines and calls it "error context".
 */
function logShaped(lines) {
  const nonEmpty = lines.filter(line => line.trim())
  if (!nonEmpty.length) return false
  let shaped = 0
  // The read tool prefixes lines with "12: "; classify the content, not the gutter.
  for (const line of nonEmpty) if (LOG_SHAPE_RE.test(stripGutter(line))) shaped++
  return shaped >= 12 && shaped / nonEmpty.length >= 0.3
}
function cjkRatio(text) {
  let cjk = 0
  let total = 0
  for (const ch of text) {
    total++
    if (/[\u3400-\u9fff]/.test(ch)) cjk++
  }
  return total ? cjk / total : 0
}

const CODE_LINE_RE =
  /^\s*(?:#\s*(?:include|define|if|ifdef|ifndef|endif|pragma|undef)\b|(?:import|from|export|use|require|package|namespace)\b|\/\/|\/\*|\*|template\b|struct\b|class\b|enum\b|union\b|typedef\b|interface\b|impl\b|fn\b|func\b|def\b)/

/** The read tool prefixes every line with "1234: "; classify the content, keep the prefix. */
function stripGutter(line) {
  return line.replace(/^\s*\d+:\s?/, '')
}

function codeLineRatio(lines) {
  const nonEmpty = lines.filter(line => line.trim())
  if (!nonEmpty.length) return 0
  let hits = 0
  for (const line of nonEmpty) {
    const body = stripGutter(line)
    if (CODE_LINE_RE.test(body) || /[{};]\s*$/.test(body) || /^\s*[})\]]+;?\s*$/.test(body)) hits++
  }
  return hits / nonEmpty.length
}

/**
 * Code wants structure, not a line sample: keep declarations and signatures,
 * drop bodies. A sampled 12/8 line window of a 7,000-line file keeps 0.7% of it
 * and none of the names a question would ask about.
 */
export function codeOutline(text, options = {}) {
  const lines = text.split('\n')
  if (lines.length < 40) return null
  if (codeLineRatio(lines) < 0.5) return null
  const kept = []
  let dropped = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const body = stripGutter(line)
    const isDecl =
      /^\s*#\s*(include|define|if|ifdef|ifndef|endif|pragma|undef)\b/.test(body) ||
      /^\s*(import|from|export|require|package|namespace|use)\b/.test(body) ||
      /^(?:template\b|struct\b|class\b|enum\b|union\b|typedef\b|interface\b|impl\b)/.test(body) ||
      /^\s*(?:[A-Za-z_][\w:<>,.[\]*&\s]*)\s+[*&]?[A-Za-z_]\w*\s*\([^;]*\)\s*[;{]?\s*$/.test(body) ||
      /^[A-Za-z_][A-Za-z0-9_\s*]*[A-Za-z0-9_]\s*\(/.test(body) ||
      /^\s*(?:async\s+)?(?:function|fn|func|def)\s+[A-Za-z_]/.test(body)
    if (isDecl) kept.push(line)
    else dropped++
  }
  if (kept.length < 3 || dropped < lines.length * 0.2 || kept.length >= lines.length * 0.8) return null
  const cap = Math.max(300, Math.floor(lines.length * 0.25))
  const body = kept.length > cap ? [...kept.slice(0, cap), `… 省略 ${kept.length - cap} 行声明 …`] : kept
  return {
    method: 'code-outline',
    lossy: true,
    text: [...body, `… ${dropped} 行实现省略（保留声明与签名）…`].join('\n'),
  }
}

/**
 * One line of aggregates for a sampled log: counts per level and per status
 * code. Sampling removes the rows a "how many 500s" question needs; the counts
 * survive instead.
 */
function logStats(lines) {
  const levels = new Map()
  const statuses = new Map()
  for (const line of lines) {
    const level = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL)\b/.exec(line)
    if (level) levels.set(level[1], (levels.get(level[1]) || 0) + 1)
    const status = /\bstatus=(\d{3})\b/.exec(line)
    if (status) statuses.set(status[1], (statuses.get(status[1]) || 0) + 1)
  }
  const parts = []
  for (const [level, count] of [...levels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) parts.push(`${level}=${count}`)
  // Status codes are few and carry the "how many 500s" answer, so keep them all.
  for (const [code, count] of [...statuses.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) parts.push(`status${code}=${count}`)
  return parts.join(' ')
}

export function logSample(text, headLinesArg = 6, tailLinesArg = 4) {
  const [headLines, tailLines] = rowBudget(headLinesArg, tailLinesArg, [6, 4])
  const lines = text.split('\n')
  if (lines.length < 30) return null
  if (!logShaped(lines)) return null
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    if (/(error|fatal|traceback|exception|timeout|failed|panic|错误|失败|拒绝)/i.test(lines[i])) {
      if (i > 0) kept.push(lines[i - 1])
      kept.push(lines[i])
      if (i + 1 < lines.length) kept.push(lines[i + 1])
    }
  }
  const uniq = [...new Set(kept.filter(Boolean))]
  if (uniq.length === 0 || uniq.length > lines.length * 0.7) return null
  const stats = logStats(lines)
  const head = lines.slice(0, headLines)
  const tail = takeTail(lines, tailLines)
  return {
    method: 'log',
    lossy: true,
    text: [
      ...head,
      stats ? `[统计] ${stats}` : null,
      `… ${lines.length - head.length - tail.length} 行省略，保留 ${uniq.length} 条错误及上下文 …`.trim(),
      ...uniq,
      ...tail,
    ].filter(Boolean).join('\n'),
  }
}

export function jsonObjectShape(text, options = {}) {
  const maxString = options.maxString ?? 360
  const maxArray = options.maxArray ?? 8
  const maxDepth = options.maxDepth ?? 2
  const t = ungutter(text).trim()
  if (t.length < 1500 || t.length > 400000) return null
  if (t[0] !== '{' || t[t.length - 1] !== '}') return null
  let value
  try {
    value = JSON.parse(t)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  let changed = false
  function clip(input, depth) {
    if (depth > maxDepth) return input
    if (typeof input === 'string') {
      if (input.length > maxString) {
        changed = true
        return `${input.slice(0, maxString)}…`
      }
      return input
    }
    if (Array.isArray(input)) {
      if (input.length > maxArray) changed = true
      return input.slice(0, maxArray).map(item => clip(item, depth + 1))
    }
    if (input && typeof input === 'object') {
      const out = {}
      for (const key of Object.keys(input)) out[key] = clip(input[key], depth + 1)
      return out
    }
    return input
  }
  const shaped = clip(value, 0)
  if (!changed) return null
  return { method: 'json-shape', lossy: true, text: JSON.stringify(shaped, null, 2) }
}

export function headTail(text, headLinesArg = 12, tailLinesArg = 8) {
  const [headLines, tailLines] = rowBudget(headLinesArg, tailLinesArg, [12, 8])
  const lines = text.split('\n')
  if (lines.length < 60) return null
  // Prose loses its meaning when sampled; do not turn a novel into 20 lines.
  if (cjkRatio(text) >= 0.35 && codeLineRatio(lines) < 0.3) return null
  const head = lines.slice(0, headLines)
  const tail = takeTail(lines, tailLines)
  return {
    method: 'headtail',
    lossy: true,
    text: [...head, `… ${lines.length - headLines - tailLines} 行省略 …`, ...tail].join('\n'),
  }
}

const PIPELINE = [
  { fn: diffContext, lossy: true },
  { fn: codeOutline, lossy: true },
  { fn: jsonArrayCsv, lossy: false },
  { fn: jsonlCsv, lossy: false },
  { fn: tableSample, lossy: true },
  { fn: logSample, lossy: true },
  { fn: jsonObjectShape, lossy: true },
  { fn: headTail, lossy: true },
]

// Quality-first policy: only transforms that keep every value (CSV) or the whole
// structure (code outline, diff) run by default. Log sampling keeps errors plus
// aggregate counts. Table row sampling and generic head/tail are opt-in because
// P5 measured them losing answers (table 6->1, head/tail is pure sampling).
const POLICY_ALLOW = {
  // quality: value-preserving (CSV) and log aggregation only. Code is NOT
  // outlined: real sessions recalled 58% of outlined files (code wants bodies),
  // so the round trip costs more than the saved tokens.
  quality: new Set([diffContext, logSample]),
  strict: new Set([diffContext]),
  aggressive: null,
}

/** Flatten text out of content blocks, including the persisted `tool-result` wrapper. */
export function contentText(content) {
  const out = []
  const walk = (list, depth) => {
    if (!Array.isArray(list) || depth > 4) return
    for (const block of list) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
      else if (block.type === 'tool-result' && Array.isArray(block.content)) walk(block.content, depth + 1)
    }
  }
  walk(content, 0)
  return out.join('\n')
}

/**
 * Compress one tool result. Returns { text, method, lossy } or null.
 * The candidate is only accepted when it is strictly smaller than the input.
 */
export function compressText(text, options = {}) {
  if (typeof text !== 'string' || !text) return null
  const minBytes = options.minBytes ?? 0
  if (text.length < minBytes) return null
  const policy = options.policy || 'quality'
  const allow = Object.prototype.hasOwnProperty.call(POLICY_ALLOW, policy) ? POLICY_ALLOW[policy] : POLICY_ALLOW.quality
  for (const entry of PIPELINE) {
    if (allow && entry.lossy && !allow.has(entry.fn)) continue
    const out = entry.fn(text, options)
    if (out && out.text.length < text.length) return out
  }
  return null
}

const PATH_RE = /(?:^|[\s"'`(])((?:\/(?![*\/])|~\/|[A-Za-z]:\\)[^\s"'`)]+)/g
const CMD_RE = /\b(?:npm|pnpm|yarn|git|node|python|pip|curl|pwsh|powershell|docker|kubectl|go|cargo|make)\b[^\n]{0,120}/g
const ERR_RE = /\b(?:ERROR|Error|Exception|Traceback|FAILED|panic|fatal)\b[^\n]{0,160}/g
const VER_RE = /\bv?\d+\.\d+(?:\.\d+)?\b/g
const URL_RE = /https?:\/\/[^\s"'`)]+/g

function collect(re, text, limit = 40) {
  const out = []
  for (const match of text.matchAll(re)) {
    const value = match[1] ?? match[0]
    if (value && !out.includes(value)) out.push(value)
    if (out.length >= limit) break
  }
  return out
}

/** Facts grouped by kind; every entry here is emitted verbatim by buildCard. */
export function collectHardFactsGrouped(text) {
  return {
    paths: collect(PATH_RE, text),
    commands: collect(CMD_RE, text),
    errors: collect(ERR_RE, text),
    versions: collect(VER_RE, text, 20),
    urls: collect(URL_RE, text, 20),
  }
}

/** Facts that must survive any compression: paths, commands, errors, versions, URLs. */
export function collectHardFacts(text) {
  const grouped = collectHardFactsGrouped(text)
  return [
    ...grouped.paths,
    ...grouped.commands,
    ...grouped.errors,
    ...grouped.versions,
    ...grouped.urls,
  ]
}

/** Build a compact card whose content is exactly the hard facts, so the gate passes by construction. */
export function buildCard(text, options = {}) {
  const grouped = collectHardFactsGrouped(text)
  const lines = []
  if (grouped.paths.length) lines.push(`Files: ${grouped.paths.join(' | ')}`)
  if (grouped.commands.length) lines.push(`Cmds: ${grouped.commands.join(' | ')}`)
  if (grouped.errors.length) lines.push(`Errors: ${grouped.errors.join(' | ')}`)
  if (grouped.versions.length) lines.push(`Versions: ${grouped.versions.join(' | ')}`)
  if (grouped.urls.length) lines.push(`URLs: ${grouped.urls.join(' | ')}`)
  const rules = anchorLines(text, { headCount: 0, limit: options.maxRules ?? 8 })
  if (rules.length) lines.push(`Rules: ${rules.join(' | ')}`)
  return lines.join('\n')
}

/** True when every collected hard fact still appears verbatim in the compressed text. */
export function hardFactsPreserved(raw, compressed) {
  for (const fact of collectHardFacts(raw)) {
    if (!compressed.includes(fact)) return false
  }
  return true
}

/**
 * Re-attach hard facts that sampling dropped, as one trailing line.
 * Sampling is allowed to lose rows; it is not allowed to lose a path, error,
 * version or URL. Appending the missing facts keeps that invariant while still
 * shrinking the body.
 */
export function withHardFacts(raw, compressed, options = {}) {
  const maxFacts = options.maxFacts ?? 160
  const maxChars = options.maxChars ?? 2400
  const missing = []
  for (const fact of collectHardFacts(raw)) {
    if (!compressed.includes(fact) && !missing.includes(fact)) missing.push(fact)
  }
  if (!missing.length) return compressed
  const kept = []
  let used = 0
  for (const fact of missing.slice(0, maxFacts)) {
    if (used + fact.length > maxChars) break
    kept.push(fact)
    used += fact.length
  }
  if (!kept.length) return compressed
  const rest = missing.length - kept.length
  return `${compressed}\n[硬事实 ${missing.length} 条] ${kept.join(' | ')}${rest > 0 ? ` | …还有 ${rest} 条` : ''}`
}

/** Extractive hard-fact lines used by turn cards and the state board. */
export function extractFactLines(text, limit = 120) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const keep = []
  for (const line of lines) {
    if (keep.length >= limit) break
    if (line.length > 400) continue
    if (
      /(^|\s)(\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(line) ||
      /\b[A-Za-z0-9_./-]+\.(ts|js|tsx|jsx|mjs|json|md|py|go|rs|java|css|html|yml|yaml|toml)\b/.test(line) ||
      /\b(ERROR|Error|Exception|FAILED|panic|错误|失败)\b/.test(line) ||
      /(必须|不要|禁止|只能|验收|格式|must|never|required)/i.test(line) ||
      /(^|\s)(npm|pnpm|git|node|python|curl|pwsh)\s/.test(line) ||
      /\d{3,}/.test(line)
    ) {
      keep.push(line)
    }
  }
  return keep.join('\n')
}

/** Anchor lines for the first user message: leading intent plus explicit constraints. */
export function anchorLines(text, options = {}) {
  const headCount = options.headCount ?? 12
  const limit = options.limit ?? 40
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const constraints = lines.filter(line =>
    /(必须|不要|禁止|只能|务必|验收|格式|must|never|required|acceptance|format)/i.test(line),
  )
  return [...new Set([...lines.slice(0, headCount), ...constraints.filter(line => line.length <= 200)])].slice(0, limit)
}
