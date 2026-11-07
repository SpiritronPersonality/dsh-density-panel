import { apply } from '../index.js'

console.log('loaded source has typeCounts:', apply.toString().includes('typeCounts'))

const handlers = new Map()
const ctx = {
  on(name, fn) {
    handlers.set(name, fn)
    return () => {}
  },
  effect(fn) {
    return fn()
  },
  tokenMeter: {
    estimateMessage: message => Math.ceil((message?.content?.[0]?.text || '').length / 4),
    measure: () => ({ surfaceTokens: 1000, totalTokens: 1100 }),
  },
  llm: { resolveModelInfo: async () => ({ context: { contextWindow: 200000 }, defaultMaxTokens: 8000 }) },
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
    register() {
      return () => {}
    },
  },
}

apply(ctx, { mode: 'balanced', write: false, surface: false })

const session = {
  id: 's1',
  seq: 10,
  requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 200000 }),
  requestHeader: () => ({ config: { maxTokens: 8000 } }),
  deriveMessages: () => [],
  append() {},
  appends: [],
}

const big = Array.from({ length: 160 }, (_, i) =>
  i === 60 ? `ERROR /data/x-${i}.csv` : `INFO row ${i} payload xxxxxxxxxxxxxxxxxxxx`,
).join('\n')

const on = handlers.get('session/event')
console.log('handler type:', typeof on)
on(session, { type: 'turn/start', data: { turn: 1 }, seq: 10 })
on(session, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }] } },
  seq: 11,
})
on(session, {
  type: 'tool/result',
  data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: big }] } },
  seq: 12,
})
on(session, { type: 'turn/end', data: { turn: 1 }, seq: 13 })

let body = ''
ctx.route.handler({ url: '/density/snapshot' }, { writeHead() {}, end(v) { body = v } })
const data = JSON.parse(body)
const s = data.sessions[0]
console.log('debug', JSON.stringify(s.debug))
console.log('replacement', JSON.stringify(s.replacement))
