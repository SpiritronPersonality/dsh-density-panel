#!/usr/bin/env node
/**
 * Offline replay over persisted DSH session logs (session.jsonl[.zstd]).
 * Read-only: computes what the density entry compressor WOULD have saved.
 *
 * usage: node tools/replay.mjs --root <sessions-dir> [--limit 15] [--out report.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { anchorLines, buildCard, compressText, contentText, extractFactLines, hardFactsPreserved, withHardFacts } from '../lib/transform.js'
import { createBoard, renderBoard, seedBoardFromText, updateBoardFromText } from '../lib/stateboard.js'

let MIN_BYTES = 600
let MIN_TOKENS = 200

function parseArgs(argv) {
  const out = { root: null, limit: 15, out: null, since: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = argv[++i]
    else if (argv[i] === '--limit') out.limit = Number(argv[++i])
    else if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--min-chars') out.minChars = Number(argv[++i])
    else if (argv[i] === '--min-tokens') out.minTokens = Number(argv[++i])
    else if (argv[i] === '--since') out.since = argv[++i]
  }
  return out
}

function walk(dir, acc) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (entry.name.startsWith('session') && (entry.name.endsWith('.zstd') || entry.name.endsWith('.jsonl'))) acc.push(full)
  }
  return acc
}

function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

function loadEvents(file) {
  const raw = fs.readFileSync(file)
  if (!file.endsWith('.zstd')) return parseLines(raw.toString('utf8'))
  // Session logs append one zstd frame per event; decompress frame by frame.
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const events = []
  let off = 0
  while (off < raw.length) {
    if (raw[off] !== 0x28) {
      off++
      continue
    }
    const next = raw.indexOf(magic, off + 4)
    const end = next < 0 ? raw.length : next
    try {
      events.push(...parseLines(zstdDecompressSync(raw.subarray(off, end)).toString('utf8')))
    } catch {}
    off = end
  }
  return events
}

function textOf(content) {
  return contentText(content)
}

function price(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u3400-\u9fff]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.6 + other / 4)
}

function replay(events) {
  let steps = 0
  let surface = 0
  let baseline = 0
  let carried = 0
  let compactions = 0
  let anchors = { count: 0, tokens: 0 }
  let sawUser = false
  let turnBuf = ''
  let turnEntrySaved = 0
  let turnMarks = []
  let turnNumber = 0
  let board = createBoard()
  const turnStats = { rawSmall: 0, cardBig: 0, facts: 0, ok: 0 }
  const active = []
  const skips = { small: 0, noMethod: 0, longer: 0, noGain: 0, facts: 0 }
  const methods = {}
  let entryRaw = 0
  let entrySaved = 0

  const addSurface = text => {
    if (!text) return 0
    const tokens = price(text)
    surface += tokens
    return tokens
  }

  for (const event of events) {
    const type = event?.type
    const data = event?.data || {}
    if (type === 'turn/start') {
      turnBuf = ''
      turnEntrySaved = 0
      turnMarks = []
      turnNumber++
    } else if (type === 'user/message') {
      const text = textOf(data.content)
      addSurface(text)
      if (!sawUser && text) {
        sawUser = true
        const picked = anchorLines(text)
        anchors = { count: picked.length, tokens: price(picked.join('\n')) }
        board = seedBoardFromText(board, text)
      }
    } else if (type === 'assistant/message') {
      const text = textOf(data.message?.content)
      addSurface(text)
      turnBuf += `${text}\n`
    } else if (type === 'tool/result') {
      const text = textOf(data.message?.content)
      addSurface(text)
      turnBuf += `${text}\n`
      if (text && text.length >= MIN_BYTES) {
        const raw = price(text)
        if (raw >= MIN_TOKENS) {
          const candidate = compressText(text)
          if (!candidate) skips.noMethod++
          else {
            const keptText = hardFactsPreserved(text, candidate.text) ? candidate.text : withHardFacts(text, candidate.text)
            if (!hardFactsPreserved(text, keptText)) skips.facts++
            else {
              const comp = price(keptText)
              if (!(comp < raw * 0.9)) skips.noGain++
              else {
                const saved = raw - comp
                entryRaw += raw
                entrySaved += saved
                const entry = { saved, kind: 'entry' }
                active.push(entry)
                turnMarks.push(entry)
                turnEntrySaved += saved
                methods[candidate.method] = (methods[candidate.method] || 0) + 1
              }
            }
          }
        } else skips.small++
      } else skips.small++
    } else if (type === 'step/start') {
      steps++
      for (const entry of active) carried += entry.saved
      baseline += surface
    } else if (type === 'compaction/start') {
      compactions++
      active.length = 0
    } else if (type === 'turn/end') {
      const raw = price(turnBuf)
      if (raw > 4096) {
        board = updateBoardFromText(board, turnBuf)
        const cardText = [
          `[density card · turn ${turnNumber}]`,
          renderBoard(board, { maxTokens: 384 }),
          buildCard(turnBuf),
        ]
          .filter(Boolean)
          .join('\n')
        const card = price(cardText)
        const after = Math.max(0, raw - turnEntrySaved)
        if (!(card > 0 && card < after * 0.9)) turnStats.cardBig++
        else if (!hardFactsPreserved(turnBuf, cardText)) turnStats.facts++
        else {
          const marked = new Set(turnMarks)
          for (let i = active.length - 1; i >= 0; i--) {
            if (marked.has(active[i])) active.splice(i, 1)
          }
          active.push({ saved: raw - card, kind: 'turn' })
          methods['turn-card'] = (methods['turn-card'] || 0) + 1
          turnStats.ok++
        }
      } else turnStats.rawSmall++
      turnBuf = ''
      turnMarks = []
    }
  }

  const staticSaved = active.reduce((sum, entry) => sum + entry.saved, 0)
  return {
    steps,
    surface,
    baseline,
    staticSaved,
    entryRaw,
    entrySaved,
    carried,
    ratio: baseline > 0 ? carried / baseline : null,
    entries: Object.values(methods).reduce((a, b) => a + b, 0),
    methods,
    skips,
    anchors,
    compactions,
    turnCards: turnStats.ok,
    turnStats,
  }
}

function median(values) {
  const sorted = values.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.root) {
    console.error('usage: node tools/replay.mjs --root <sessions-dir> [--limit N] [--since ISO] [--min-chars N] [--min-tokens N] [--out file]')
    process.exit(2)
  }
  if (typeof args.minChars === 'number' && isFinite(args.minChars)) MIN_BYTES = args.minChars
  if (typeof args.minTokens === 'number' && isFinite(args.minTokens)) MIN_TOKENS = args.minTokens
  const files = walk(args.root, [])
  const since = args.since ? Date.parse(args.since) : null
  const chosen = files
    .filter(file => (since ? fs.statSync(file).mtimeMs >= since : true))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)
    .slice(0, args.limit)
  const rows = []
  for (const file of chosen) {
    try {
      const events = loadEvents(file)
      const metrics = replay(events)
      rows.push({ file: path.relative(args.root, file), events: events.length, ...metrics })
    } catch (error) {
      rows.push({ file, error: String(error) })
    }
  }
  const ratios = rows.map(r => r.ratio).filter(v => typeof v === 'number')
  const summary = {
    sessions: rows.length,
    medianRatio: median(ratios),
    meanRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
    totalEntries: rows.reduce((a, b) => a + (b.entries || 0), 0),
    totalEntryRaw: rows.reduce((a, b) => a + (b.entryRaw || 0), 0),
    totalEntrySaved: rows.reduce((a, b) => a + (b.entrySaved || 0), 0),
    totalTurnCards: rows.reduce((a, b) => a + (b.turnCards || 0), 0),
    totalCarried: rows.reduce((a, b) => a + (b.carried || 0), 0),
    totalBaseline: rows.reduce((a, b) => a + (b.baseline || 0), 0),
  }
  const report = { generatedAt: new Date().toISOString(), summary, rows }
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ summary }, null, 2))
  for (const row of rows.slice(0, 12)) {
    if (row.error) {
      console.log(`ERR  ${row.file}: ${row.error}`)
      continue
    }
    const pct = row.ratio === null ? 'n/a' : `${(row.ratio * 100).toFixed(2)}%`
    console.log(
      `${pct.padStart(8)}  steps=${String(row.steps).padStart(4)} entries=${String(row.entries).padStart(3)} ` +
        `turns=${String(row.turnCards ?? 0).padStart(3)} ` +
        `static=${String(row.staticSaved).padStart(7)} carried=${String(row.carried).padStart(8)} anchors=${row.anchors.count} ${path.basename(path.dirname(row.file))}`,
    )
  }
}

main()
