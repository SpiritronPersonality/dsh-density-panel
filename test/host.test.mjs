import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

function makeCtx() {
  const handlers = new Map()
  const ctx = {
    handlers,
    on(name, fn) {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    },
    effect(fn) {
      return fn()
    },
    get(name) {
      return name === 'spillStore' ? ctx.spill : undefined
    },
    tokenMeter: {
      estimateMessage: message => Math.ceil((message?.content?.[0]?.text || '').length / 4),
      measure: () => ({ surfaceTokens: 1000, totalTokens: 1100 }),
    },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 200000 }, defaultMaxTokens: 8000 }),
    },
    webServer: {
      register(route) {
        ctx.route = route
        return () => {}
      },
    },
    commands: {
      register(definition) {
        ctx.command = definition
        return () => {}
      },
    },
    tools: {
      register(definition) {
        ctx.toolDefs = ctx.toolDefs || []
        ctx.toolDefs.push(definition)
        return () => {}
      },
    },
  }
  return ctx
}

function makeSession(id = 's1') {
  const session = {
    id,
    seq: 10,
    requestContext: () => ({ provider: 'test-provider', model: 'test-model', contextWindow: 200000 }),
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model', maxTokens: 8000 } }),
    deriveMessages: () => [],
    appends: [],
    append(type, data, opts) {
      session.appends.push({ type, data, opts })
      session.seq += 1
      return { type, seq: session.seq, data }
    },
  }
  return session
}

function bigLog(count = 160) {
  return Array.from({ length: count }, (_, i) => {
    if (i === 60) return `2026-11-04T00:00:00Z ERROR worker failed: ENOENT /data/input-${i}.csv`
    return `2026-11-04T00:00:00Z INFO worker ${i} processed batch ${i} payload ${'x'.repeat(20)}`
  }).join('\n')
}

function snapshot(ctx) {
  let body = ''
  const res = {
    writeHead() {},
    end(value) {
      body = value
    },
  }
  ctx.route.handler({ url: '/density/snapshot' }, res)
  return JSON.parse(body)
}

function boot(config) {
  const ctx = makeCtx()
  apply(ctx, config)
  return ctx
}

test('state machine: step, entry, snapshot', () => {
  const ctx = boot()
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  ctx.handlers.get('tools/result')(
    { agent: { id: 's1' }, name: 'pwsh' },
    { content: [{ type: 'text', text: bigLog() }] },
  )
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 2 })
  const snap = snapshot(ctx)
  assert.ok(snap.v >= 6)
  assert.equal(snap.sessions.length, 1)
  const s = snap.sessions[0]
  assert.equal(s.saved.entryCount, 1)
  assert.ok(s.saved.static > 0)
  assert.equal(s.debug.toolSeen, 1)
  assert.equal(s.trigger, 126464)
})

test('sampling that drops a hard fact re-attaches it instead of skipping', () => {
  const ctx = boot()
  const session = makeSession()
  const lines = Array.from({ length: 200 }, (_, i) => `2026-11-06T09:00:00.000Z INFO worker ${i} processed batch ${i}`)
  lines[50] = '2026-11-06T09:00:00.000Z INFO worker 50 opened /srv/important/config.yaml'
  lines[120] = '2026-11-06T09:00:00.000Z ERROR worker 120 failed'
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  ctx.handlers.get('tools/result')(
    { agent: { id: 's1' }, name: 'read' },
    { content: [{ type: 'text', text: lines.join('\n') }] },
  )
  const snap = snapshot(ctx)
  const s = snap.sessions[0]
  assert.equal(s.saved.entryCount, 1)
  assert.equal(s.debug.skipFacts, 0)
})

test('small window falls back to a safety line and flags no native compaction', () => {
  const ctx = boot()
  const session = {
    id: 's2',
    seq: 3,
    requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 50000 }),
    requestHeader: () => ({ config: { maxTokens: 8000 } }),
    deriveMessages: () => [],
  }
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  const snap = snapshot(ctx)
  const s = snap.sessions[0]
  assert.equal(s.noFallback, true)
  assert.equal(s.trigger, 50000 - 8000 - 2048)
})

test('turn card replaces the entry savings of the same turn (no double count)', () => {
  const ctx = boot()
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  ctx.handlers.get('tools/result')(
    { agent: { id: 's1' }, name: 'pwsh' },
    { content: [{ type: 'text', text: bigLog() }] },
  )
  const prose = Array.from({ length: 2000 }, () => '普通描述文字，没有硬事实。').join('\n')
  ctx.handlers.get('session/event')(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: `${prose}\nsee /a/b.ts` }] } },
    seq: 3,
  })
  ctx.handlers.get('session/event')(session, { type: 'turn/end', data: {}, seq: 4 })
  const snap = snapshot(ctx)
  const s = snap.sessions[0]
  assert.equal(s.saved.entryCount, 0)
  assert.equal(s.saved.turnCount, 1)
  assert.ok(s.saved.static > 0)
})

test('quality policy leaves table results untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-host-'))
  const ctx = boot({ mode: 'safe', write: true, archiveDir: dir })
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  const table = [
    '| id | item | score |',
    '|---|---|---|',
    ...Array.from({ length: 30 }, (_, i) => `| ${i} | item-${i} | ${i * 3} |`),
  ].join('\n')
  const decision = await ctx.handlers.get('tools/post-execute')(
    { name: 'pwsh', agent: { id: 's1' }, callId: 'c1' },
    { isError: false, content: [{ type: 'text', text: table }], value: null },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content, undefined, 'no rewrite in quality mode')
  const s = snapshot(ctx).sessions[0]
  assert.equal(s.saved.entryCount, 0)
  assert.equal(s.debug.skipNoMethod, 1)
})

test('write mode records skip reasons instead of leaving them at zero', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-host-'))
  const ctx = boot({ mode: 'safe', write: true, archiveDir: dir })
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })

  const small = 'ok\n'.repeat(60)
  await ctx.handlers.get('tools/post-execute')(
    { name: 'pwsh', agent: { id: 's1' }, callId: 'c1' },
    { isError: false, content: [{ type: 'text', text: small }], value: null },
    async () => ({ kind: 'accept' }),
  )

  const prose = Array.from({ length: 240 }, () => '普通说明文字').join(' ')
  await ctx.handlers.get('tools/post-execute')(
    { name: 'read', agent: { id: 's1' }, callId: 'c2' },
    { isError: false, content: [{ type: 'text', text: prose }], value: null },
    async () => ({ kind: 'accept' }),
  )

  const s = snapshot(ctx).sessions[0]
  assert.equal(s.debug.toolSeen, 2)
  assert.equal(s.debug.skipSmall, 1)
  assert.equal(s.debug.skipNoMethod, 1)
})

test('shadow mode never rewrites a tool result and registers no tool', async () => {
  const ctx = boot()
  const decision = await ctx.handlers.get('tools/post-execute')(
    { name: 'pwsh', agent: { id: 's1' }, callId: 'c1' },
    { isError: false, content: [{ type: 'text', text: bigLog() }], value: null },
    async () => ({ kind: 'accept', content: 'unchanged' }),
  )
  assert.equal(decision.content, 'unchanged')
  assert.equal(ctx.toolDefs, undefined)
})

test('safe mode compresses at post-execute, archives the original, and recalls it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-host-'))
  const ctx = boot({ mode: 'safe', write: true, archiveDir: dir })
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  const text = bigLog()
  const decision = await ctx.handlers.get('tools/post-execute')(
    { name: 'pwsh', agent: { id: 's1' }, callId: 'c1' },
    { isError: false, content: [{ type: 'text', text }], value: null },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 1)
  assert.ok(decision.content[0].text.length < text.length)
  const marker = decision.content[0].text.match(/#density-[0-9a-f]{8}/)?.[0]
  assert.ok(marker, 'marker present')

  const tool = (ctx.toolDefs || []).find(definition => definition.name === 'density_recall')
  assert.ok(tool, 'recall tool registered')
  const recalled = await tool.execute({ marker }, { agent: { id: 's1' } })
  assert.match(recalled, /历史数据/)
  assert.match(recalled, /ERROR worker/)
  const archived = fs.readdirSync(path.join(dir, 's1')).filter(name => name.endsWith('.txt'))
  assert.equal(archived.length, 1)

  const snap = snapshot(ctx)
  assert.ok(snap.sessions[0].timings.entrySamples >= 1)
  assert.ok(snap.sessions[0].timings.entryP95Ms >= 0)
  assert.ok(snap.sessions[0].saved.recallCalls >= 1)
  assert.ok(snap.sessions[0].saved.recallTokens > 0)
  assert.ok(snap.sessions[0].saved.entryCount >= 1)
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 2 })
  const afterSchema = snapshot(ctx)
  assert.ok(afterSchema.sessions[0].saved.schemaTokens > 0)
  assert.ok(afterSchema.sessions[0].saved.carried > 0)
})

test('safe mode without any compression registers no recall tool and costs no tokens', async () => {
  const ctx = boot({ mode: 'safe', write: true })
  assert.equal(ctx.toolDefs, undefined)
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  const snap = snapshot(ctx)
  assert.equal(snap.sessions[0].saved.schemaTokens, 0)
})

test('archived originals are also offered to spillStore when available', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-host-'))
  const ctx = boot({ mode: 'safe', write: true, archiveDir: dir })
  ctx.spill = {
    calls: [],
    async saveText(input) {
      this.calls.push(input)
      return { locator: 'spill-1', bytes: input.content.length, retrievalHint: 'spill' }
    },
  }
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  await ctx.handlers.get('tools/post-execute')(
    { name: 'pwsh', agent: { id: 's1' }, callId: 'c1' },
    { isError: false, content: [{ type: 'text', text: bigLog() }], value: null },
    async () => ({ kind: 'accept' }),
  )
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(ctx.spill.calls.length, 1)
  assert.equal(ctx.spill.calls[0].owner.sessionId, 's1')
  assert.match(ctx.spill.calls[0].suggestedName, /^#density-/)
})

test('dry-run records plan timing samples', () => {
  const ctx = boot({ mode: 'balanced', write: false, surface: false })
  const session = makeSession()
  runTurn(ctx, session)
  const snap = snapshot(ctx)
  assert.ok(snap.sessions[0].timings.planSamples >= 1)
  assert.ok(snap.sessions[0].timings.planP95Ms >= 0)
})

function runTurn(ctx, session) {
  const on = ctx.handlers.get('session/event')
  on(session, { type: 'turn/start', data: { turn: 1 }, seq: 10 })
  on(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }] } },
    seq: 11,
  })
  on(session, {
    type: 'tool/result',
    data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: bigLog() }] } },
    seq: 12,
  })
  on(session, { type: 'turn/end', data: { turn: 1 }, seq: 13 })
}

test('balanced dry-run records a replacement plan without appending', () => {
  const ctx = boot({ mode: 'balanced', write: false, surface: false })
  const session = makeSession()
  runTurn(ctx, session)
  const snap = snapshot(ctx)
  const s = snap.sessions[0]
  assert.equal(s.replacement.planCount, 1)
  assert.equal(s.replacement.lastPlan.balanced, true)
  assert.equal(s.replacement.lastPlan.ok, true)
  assert.equal(session.appends.length, 0)
})

test('balanced + write + surface appends exactly one replace intent', async () => {
  const ctx = boot({ mode: 'balanced', write: true, surface: true })
  const session = makeSession()
  runTurn(ctx, session)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(session.appends.length, 1)
  const append = session.appends[0]
  assert.equal(append.type, 'user/message')
  assert.equal(append.opts.surfaceOp.op, 'replace')
  assert.equal(append.opts.surfaceOp.startSeq, 11)
  assert.equal(append.opts.surfaceOp.endSeq, 12)
  assert.deepEqual(append.opts.sourceEventSeqs, [11, 12])
  assert.match(append.data.content[0].text, /Files:|Errors:|Rules:/)
  assert.match(append.data.id, /^[0-9a-f-]{36}$/, 'message must carry an id')
  assert.equal('id' in append.data, true)
})

function makeSessionWithPrompt(id, prompt) {
  const session = makeSession(id)
  session.deriveMessages = () => [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  return session
}

test('turn card carries the state board', async () => {
  const ctx = boot({ mode: 'balanced', write: true, surface: true })
  const session = makeSessionWithPrompt('s1', '必须只读\n不要改写稳定前缀\n其他说明')
  runTurn(ctx, session)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(session.appends.length, 1)
  const text = session.appends[0].data.content[0].text
  assert.match(text, /\[density card/)
  assert.match(text, /Goal: 必须只读/)
  assert.match(text, /Constraints:/)
})

test('native compaction re-injects anchors and board when writes are enabled', async () => {
  const ctx = boot({ mode: 'balanced', write: true, surface: true })
  const session = makeSessionWithPrompt('s1', '必须只读\n不要改写稳定前缀')
  const on = ctx.handlers.get('session/event')
  on(session, { type: 'step/start', data: {}, seq: 1 })
  on(session, { type: 'compaction/end', data: {}, seq: 2 })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(session.appends.length, 1)
  const append = session.appends[0]
  assert.equal(append.opts.surfaceOp, 'append')
  assert.match(append.data.content[0].text, /\[density re-anchor/)
  assert.match(append.data.id, /^[0-9a-f-]{36}$/, 're-anchor must carry an id')
  assert.match(append.data.content[0].text, /必须只读/)
})

test('no re-injection happens while writes are disabled', async () => {
  const ctx = boot({ mode: 'balanced', write: false })
  const session = makeSessionWithPrompt('s1', '必须只读')
  const on = ctx.handlers.get('session/event')
  on(session, { type: 'step/start', data: {}, seq: 1 })
  on(session, { type: 'compaction/end', data: {}, seq: 2 })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(session.appends.length, 0)
})

test('surface replace validates the live surface range', async () => {
  const ctx = boot({ mode: 'balanced', write: true, surface: true })
  const session = makeSession()
  session.surface = { nodes: [11, 12] }
  runTurn(ctx, session)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(session.appends.length, 1)
})

test('surface replace is rejected when the range does not match the live surface', async () => {
  const ctx = boot({ mode: 'balanced', write: true, surface: true })
  const session = makeSession()
  session.surface = { nodes: [11] }
  runTurn(ctx, session)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(session.appends.length, 0)
  const snap = snapshot(ctx)
  assert.equal(snap.sessions[0].replacement.replaceErrors, 1)
})

test('surface replace respects the minimum saving ratio', async () => {
  const ctx = boot({ mode: 'balanced', write: true, surface: true, surfaceMinRatio: 0.999 })
  const session = makeSession()
  runTurn(ctx, session)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(session.appends.length, 0)
})

test('a leading node-0 system message is excluded from the replace range', async () => {
  const ctx = boot({ mode: 'balanced', write: true, surface: true })
  const session = makeSession()
  session.surface = { nodes: [11, 12, 13] }
  const on = ctx.handlers.get('session/event')
  on(session, { type: 'turn/start', data: { turn: 1 }, seq: 10 })
  on(session, {
    type: 'system/message',
    data: { message: { content: [{ type: 'text', text: 'system prompt' }] } },
    seq: 11,
  })
  on(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }] } },
    seq: 12,
  })
  on(session, {
    type: 'tool/result',
    data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: bigLog() }] } },
    seq: 13,
  })
  on(session, { type: 'turn/end', data: { turn: 1 }, seq: 14 })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(session.appends.length, 1)
  assert.equal(session.appends[0].opts.surfaceOp.startSeq, 12)
  assert.equal(session.appends[0].opts.surfaceOp.endSeq, 13)
  assert.deepEqual(session.appends[0].opts.sourceEventSeqs, [12, 13])
  assert.doesNotMatch(session.appends[0].data.content[0].text, /system prompt/)
})

test('mirror writes actual and raw text plus a token comparison', async () => {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-archive-'))
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-mirror-'))
  const ctx = boot({ mode: 'safe', write: true, archiveDir, mirrorDir })
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  const decision = await ctx.handlers.get('tools/post-execute')(
    { name: 'pwsh', agent: { id: 's1' }, callId: 'c1' },
    { isError: false, content: [{ type: 'text', text: bigLog() }], value: null },
    async () => ({ kind: 'accept' }),
  )
  const compressed = decision.content[0].text
  session.deriveMessages = () => [{ role: 'tool', content: [{ type: 'text', text: compressed }] }]
  ctx.handlers.get('session/event')(session, { type: 'turn/start', data: { turn: 1 }, seq: 5 })

  const raw = fs.readFileSync(path.join(mirrorDir, 's1.raw.txt'), 'utf8')
  const actual = fs.readFileSync(path.join(mirrorDir, 's1.actual.txt'), 'utf8')
  assert.match(raw, /ERROR worker/)
  assert.match(actual, /#density-/)
  assert.ok(actual.length < raw.length)
  const tokens = JSON.parse(fs.readFileSync(path.join(mirrorDir, 's1.tokens.json'), 'utf8'))
  assert.ok(tokens.rawTokens > tokens.actualTokens)
  const snap = snapshot(ctx)
  assert.equal(snap.sessions[0].mirror.savedTokens, tokens.savedTokens)
})

test('recall and mirror rescan the archive after a plugin restart', async () => {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-archive-'))
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-mirror-'))
  const ctx1 = boot({ mode: 'safe', write: true, archiveDir, mirrorDir })
  const s1 = makeSession('s1')
  ctx1.handlers.get('session/event')(s1, { type: 'step/start', data: {}, seq: 1 })
  const decision = await ctx1.handlers.get('tools/post-execute')(
    { name: 'pwsh', agent: { id: 's1' }, callId: 'c1' },
    { isError: false, content: [{ type: 'text', text: bigLog() }], value: null },
    async () => ({ kind: 'accept' }),
  )
  const compressed = decision.content[0].text
  const marker = compressed.match(/#density-[0-9a-f]{8}/)?.[0]
  assert.ok(marker)

  const ctx2 = boot({ mode: 'safe', write: true, archiveDir, mirrorDir })
  const s2 = makeSession('s1')
  ctx2.handlers.get('session/event')(s2, { type: 'step/start', data: {}, seq: 1 })
  await ctx2.handlers.get('tools/post-execute')(
    { name: 'pwsh', agent: { id: 's1' }, callId: 'c2' },
    {
      isError: false,
      content: [{ type: 'text', text: bigLog() }],
      value: null,
    },
    async () => ({ kind: 'accept' }),
  )
  const tool = (ctx2.toolDefs || []).find(definition => definition.name === 'density_recall')
  const recalled = await tool.execute({ marker }, { agent: { id: 's1' } })
  assert.match(recalled, /ERROR worker/)

  s2.deriveMessages = () => [{ role: 'tool', content: [{ type: 'text', text: compressed }] }]
  ctx2.handlers.get('session/event')(s2, { type: 'turn/start', data: { turn: 1 }, seq: 5 })
  const summary = JSON.parse(fs.readFileSync(path.join(mirrorDir, 's1.tokens.json'), 'utf8'))
  assert.ok(summary.rawTokens > summary.actualTokens)
})

test('density command returns a readable status line', () => {
  const ctx = boot()
  const result = ctx.command.handler()
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Density shadow/)
})

test('window ledger records what a window saved and survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-host-'))
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-ledger-'))
  const ctx = boot({ mode: 'safe', write: true, archiveDir: dir, ledgerDir })
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  const decision = await ctx.handlers.get('tools/post-execute')(
    { name: 'pwsh', agent: { id: 's1' }, callId: 'c1' },
    { isError: false, content: [{ type: 'text', text: bigLog() }], value: null },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  // turn/end flushes the live window snapshot to disk
  ctx.handlers.get('session/event')(session, { type: 'turn/end', data: {}, seq: 2 })

  const snap = snapshot(ctx)
  const s = snap.sessions[0]
  assert.ok(s.window, 'live window exposed')
  assert.ok(s.window.entries >= 1)
  assert.ok(s.window.entrySaved > 0)
  assert.ok(Array.isArray(s.windows) && s.windows.length >= 1)

  const files = fs.readdirSync(ledgerDir)
  assert.equal(files.length, 1)
  const lines = fs.readFileSync(path.join(ledgerDir, files[0]), 'utf8').split('\n').filter(Boolean)
  const row = JSON.parse(lines[lines.length - 1])
  assert.equal(row.sessionId, 's1')
  assert.ok(row.entries >= 1)
  assert.equal(row.policy, 'quality')
})

test('memory tool output is never compressed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'density-host-'))
  const ctx = boot({ mode: 'safe', write: true, archiveDir: dir })
  const session = makeSession()
  ctx.handlers.get('session/event')(session, { type: 'step/start', data: {}, seq: 1 })
  // bigLog() is log-shaped: without the whitelist this would be compressed.
  const decision = await ctx.handlers.get('tools/post-execute')(
    { name: 'cairn_recall', agent: { id: 's1' }, callId: 'c1' },
    { isError: false, content: [{ type: 'text', text: bigLog() }], value: null },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content, undefined, 'memory output must pass through')
  const s = snapshot(ctx).sessions[0]
  assert.equal(s.saved.entryCount, 0)
  assert.equal(s.debug.skipProtected, 1)
})

test('package version tracks the runtime VERSION constant', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const match = /const VERSION = (\d+)/.exec(src)
  assert.ok(match, 'VERSION constant present')
  const minor = Number(String(pkg.version).split('.')[1])
  assert.equal(minor, Number(match[1]), 'package.json minor must equal VERSION')
})
