#!/usr/bin/env node
/**
 * Corpus acceptance for the entry compressor.
 *
 * Takes a real long text (novel / source file), slices one tool-result-sized
 * chunk out of it, and measures what the plugin's real pipeline does to it:
 *
 *   1. compress ratio          — chars and estimated tokens kept
 *   2. hard-fact survival      — every path/error/version/URL must survive
 *   3. detail survival         — unique substrings sampled from the chunk; if a
 *                                probe is gone, a question targeting it cannot
 *                                be answered from the compressed text alone
 *
 * Detail survival is the honest proxy for answerability: the facts gate only
 * knows about paths and errors, so narrative prose and ordinary code pass it
 * while their content may be gone.
 *
 * usage: node tools/corpus-acceptance.mjs --file <path> [--start 600000] [--size 200000] [--out report.json]
 */
import fs from 'node:fs'
import { compressText, collectHardFacts, hardFactsPreserved, withHardFacts } from '../lib/transform.js'

const MIN_CHARS = 600
const MIN_TOKENS = 150

function parseArgs(argv) {
  const out = { file: null, start: null, size: 200000, out: null, seed: 20261107 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') out.file = argv[++i]
    else if (argv[i] === '--start') out.start = Number(argv[++i])
    else if (argv[i] === '--size') out.size = Number(argv[++i])
    else if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--seed') out.seed = Number(argv[++i])
  }
  return out
}

function price(text) {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u3400-\u9fff]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.6 + other / 4)
}

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function countOccurrences(text, needle) {
  let count = 0
  let at = 0
  while (true) {
    const i = text.indexOf(needle, at)
    if (i < 0) return count
    count++
    at = i + needle.length
  }
}

/** Unique random substrings from a range of the chunk; each one is a "detail". */
function sampleProbes(chunk, rand, options) {
  const { from, to, length, want } = options
  const probes = []
  const seen = new Set()
  let guard = 0
  while (probes.length < want && guard++ < want * 400) {
    const at = Math.floor(from + rand() * (to - from))
    if (at + length > chunk.length) continue
    const probe = chunk.slice(at, at + length)
    if (/\n/.test(probe) || seen.has(probe)) continue
    seen.add(probe)
    if (countOccurrences(chunk, probe) !== 1) continue
    probes.push({ at, probe })
  }
  return probes
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file) {
    console.error('usage: node tools/corpus-acceptance.mjs --file <path> [--start N] [--size N]')
    process.exit(2)
  }
  const raw = fs.readFileSync(args.file, 'utf8')
  const size = Math.min(args.size, raw.length)
  const start = args.start === null ? Math.max(0, Math.floor((raw.length - size) / 2)) : Math.min(args.start, Math.max(0, raw.length - size))
  const chunk = raw.slice(start, start + size)

  const rawTokens = price(chunk)
  const candidate = chunk.length >= MIN_CHARS && rawTokens >= MIN_TOKENS ? compressText(chunk) : null
  const result = {
    file: args.file,
    fileBytes: raw.length,
    start,
    size: chunk.length,
    chars: chunk.length,
    rawTokens,
    gate: { minChars: MIN_CHARS, minTokens: MIN_TOKENS, passed: Boolean(candidate) },
    method: candidate ? candidate.method : null,
    lossy: candidate ? candidate.lossy : null,
  }

  if (!candidate) {
    result.verdict = 'gate-rejected'
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const kept = hardFactsPreserved(chunk, candidate.text) ? candidate.text : withHardFacts(chunk, candidate.text)
  result.keptChars = kept.length
  result.keptPct = Number(((kept.length / chunk.length) * 100).toFixed(2))
  result.keptTokens = price(kept)
  result.tokenRatio = Number(((result.keptTokens / rawTokens) * 100).toFixed(2))
  result.facts = {
    total: collectHardFacts(chunk).length,
    preserved: hardFactsPreserved(chunk, kept),
  }

  const rand = mulberry32(args.seed)
  const middle = sampleProbes(chunk, rand, { from: Math.floor(chunk.length * 0.2), to: Math.floor(chunk.length * 0.8), length: 16, want: 24 })
  const edges = sampleProbes(chunk, rand, { from: 0, to: Math.min(4000, chunk.length - 17), length: 16, want: 8 })
  const survive = (probes) => probes.filter(p => kept.includes(p.probe)).length
  // Symbols: function definitions (column-0 signatures) are what a code
  // question names. Falls back to called identifiers when the chunk has none.
  const symbolPool = []
  for (const line of chunk.split('\n')) {
    const match = /^[A-Za-z_][A-Za-z0-9_\s*]*\b([A-Za-z_]\w{4,})\s*\(/.exec(line)
    if (match && !symbolPool.includes(match[1])) symbolPool.push(match[1])
  }
  if (!symbolPool.length) {
    for (const match of chunk.matchAll(/\b[A-Za-z_]\w{5,}\s*\(/g)) {
      const name = match[0].replace(/\s*\($/, '')
      if (!symbolPool.includes(name)) symbolPool.push(name)
    }
  }
  const symbols = []
  while (symbols.length < 24 && symbolPool.length > symbols.length && symbolPool.length) {
    const pick = symbolPool[Math.floor(rand() * symbolPool.length)]
    if (!symbols.includes(pick)) symbols.push(pick)
  }
  result.probes = {
    middle: { sampled: middle.length, survived: survive(middle), rate: middle.length ? Number(((survive(middle) / middle.length) * 100).toFixed(1)) : null },
    edges: { sampled: edges.length, survived: survive(edges), rate: edges.length ? Number(((survive(edges) / edges.length) * 100).toFixed(1)) : null },
    symbols: { sampled: symbols.length, survived: symbols.filter(s => kept.includes(s)).length },
  }
  result.example = {
    keptHead: kept.slice(0, 220),
    missingProbes: middle.filter(p => !kept.includes(p.probe)).slice(0, 3).map(p => p.probe),
  }
  const symRate = result.probes.symbols.sampled ? result.probes.symbols.survived / result.probes.symbols.sampled : 0
  result.verdict =
    result.probes.middle.rate >= 90
      ? 'content-preserving'
      : symRate >= 0.8
        ? 'structure-preserving'
        : result.probes.middle.rate >= 50
          ? 'partly-lossy'
          : 'pointer-only'

  if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}

main()
