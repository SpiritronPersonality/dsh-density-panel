import test from 'node:test'
import assert from 'node:assert/strict'
import { checkPairing, isSurfaceEvent, planTurn } from '../lib/turnplan.js'

const assistantCall = {
  seq: 11,
  type: 'assistant/message',
  data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }] } },
}
const toolResult = {
  seq: 12,
  type: 'tool/result',
  data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(4000) }] } },
}
const price = text => Math.ceil(text.length / 4)

test('a whole turn with paired tool call is replaceable', () => {
  const plan = planTurn({ events: [assistantCall, toolResult], card: 'Files: /a.ts', price, turn: 3 })
  assert.equal(plan.ok, true)
  assert.equal(plan.balanced, true)
  assert.equal(plan.startSeq, 11)
  assert.equal(plan.endSeq, 12)
  assert.equal(plan.surfaceCount, 2)
  assert.deepEqual(plan.sourceSeqs, [11, 12])
  assert.ok(plan.saving > 900)
})

test('a missing tool result breaks pairing and blocks the plan', () => {
  const plan = planTurn({ events: [assistantCall], card: 'card', price })
  assert.equal(plan.ok, false)
  assert.equal(plan.balanced, false)
  assert.equal(plan.reason, 'pairing')
})

test('an orphan tool result also blocks the plan', () => {
  const plan = planTurn({ events: [toolResult], card: 'card', price })
  assert.equal(plan.balanced, false)
})

test('a card that does not save enough is rejected', () => {
  const plan = planTurn({ events: [assistantCall, toolResult], card: 'x'.repeat(4000), price })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'no-gain')
})

test('non-surface events are ignored and empty input is reported', () => {
  assert.equal(isSurfaceEvent({ type: 'tool/call' }), false)
  const plan = planTurn({ events: [{ seq: 1, type: 'tool/call', data: {} }], card: 'card', price })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'no-surface')
})

test('in-history system messages are part of the replaceable surface', () => {
  const system = {
    seq: 8,
    type: 'system/message',
    data: { message: { content: [{ type: 'text', text: 'prompt update' }] } },
  }
  const plan = planTurn({ events: [system, assistantCall, toolResult], card: 'card', price })
  assert.equal(plan.surfaceCount, 3)
  assert.equal(plan.startSeq, 8)
  assert.equal(plan.endSeq, 12)
  assert.equal(plan.balanced, true)
})

test('checkPairing tolerates interleaved unrelated events', () => {
  const events = [assistantCall, toolResult, { seq: 13, type: 'step/start', data: {} }]
  assert.equal(checkPairing(events), true)
})
