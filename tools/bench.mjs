/**
 * Micro-benchmark for the post-execute compression path.
 * Reports p50/p95/p99 latency of one tool-result decision (including archive write).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const ctx = {
  handlers: new Map(),
  on(name, fn) {
    this.handlers.set(name, fn)
    return () => {}
  },
  effect(fn) {
    return fn()
  },
  tokenMeter: {
    estimateMessage: message => Math.ceil((message?.content?.[0]?.text || '').length / 4),
    measure: () => ({ surfaceTokens: 1000, totalTokens: 1100 }),
  },
  llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1000000 }, defaultMaxTokens: 8000 }) },
  webServer: { register: () => () => {} },
  commands: { register: () => () => {} },
  tools: { register: () => () => {} },
}

const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-bench-'))
apply(ctx, { mode: 'safe', write: true, archiveDir })

const post = ctx.handlers.get('tools/post-execute')
const session = {
  id: 'bench',
  seq: 1,
  requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 1000000 }),
  requestHeader: () => ({ config: { maxTokens: 8000 } }),
  deriveMessages: () => [],
  append() {},
}
ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })

function logOf(n) {
  return Array.from({ length: n }, (_, i) =>
    i % 40 === 0
      ? `2026-11-04T00:00:00Z ERROR worker ${i} failed: ENOENT /data/input-${i}.csv`
      : `2026-11-04T00:00:00Z INFO worker ${i} processed batch ${i} payload-payload-payload`,
  ).join('\n')
}

function tableOf(n) {
  return ['| id | name | value |', '|---|---|---|']
    .concat(Array.from({ length: n }, (_, i) => `| ${i} | name-${i} | ${i * 3} |`))
    .join('\n')
}

const samples = []
for (let i = 0; i < 300; i++) {
  const text = i % 2 === 0 ? logOf(150) : tableOf(200)
  const started = Date.now()
  await post(
    { name: 'pwsh', agent: { id: 'bench' }, callId: `c${i}` },
    { isError: false, content: [{ type: 'text', text }], value: null },
    async () => ({ kind: 'accept' }),
  )
  samples.push(Date.now() - started)
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}

const summary = {
  runs: samples.length,
  p50: percentile(samples, 0.5),
  p95: percentile(samples, 0.95),
  p99: percentile(samples, 0.99),
  max: Math.max(...samples),
  mean: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2)),
}
console.log(JSON.stringify(summary, null, 2))
fs.rmSync(archiveDir, { recursive: true, force: true })
