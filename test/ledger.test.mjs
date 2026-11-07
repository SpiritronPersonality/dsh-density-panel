import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WindowLedger } from '../lib/ledger.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'density-ledger-'))
}

test('ledger keeps the freshest snapshot per window and newest first', () => {
  const dir = tempDir()
  const ledger = new WindowLedger({ dir })
  ledger.record('s1', { windowId: 'w1', at: 1, openedAt: 1, entries: 1 })
  ledger.record('s1', { windowId: 'w1', at: 2, openedAt: 1, entries: 3, closed: true })
  ledger.record('s1', { windowId: 'w2', at: 3, openedAt: 3, entries: 0 })
  const rows = ledger.recent('s1', 8)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].windowId, 'w2')
  assert.equal(rows[1].windowId, 'w1')
  assert.equal(rows[1].entries, 3)
  assert.equal(rows[1].closed, true)
})

test('ledger survives a restart because it is plain JSONL on disk', () => {
  const dir = tempDir()
  new WindowLedger({ dir }).record('s2', { windowId: 'w9', at: 1, openedAt: 1, entries: 7 })
  const reopened = new WindowLedger({ dir })
  const rows = reopened.recent('s2')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].entries, 7)
})

test('ledger never throws on a bad directory', () => {
  const ledger = new WindowLedger({ dir: path.join(tempDir(), 'missing', 'deeper') })
  const written = ledger.record('s3', { windowId: 'w1', at: 1, openedAt: 1 })
  assert.ok(written)
  assert.equal(ledger.recent('s3').length, 1)
  assert.equal(ledger.recent('').length, 0)
})
