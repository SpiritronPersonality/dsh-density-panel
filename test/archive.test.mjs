import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArchiveStore, markerFor, queryArchive, sliceForRecall } from '../lib/archive.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'density-archive-'))
}

test('marker is stable for the same salt and content', () => {
  const a = markerFor('hello', 'salt')
  const b = markerFor('hello', 'salt')
  const c = markerFor('hello', 'other')
  assert.match(a, /^#density-[0-9a-f]{8}$/)
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('archive save/read roundtrips and persists across instances', () => {
  const dir = tempDir()
  const store = new ArchiveStore({ dir })
  const text = 'line one\nline two\nERROR ENOENT /tmp/x'
  const ref = store.save({ sessionId: 's1', content: text, kind: 'tool', label: 'pwsh' })
  assert.equal(ref.bytes, Buffer.byteLength(text))
  assert.equal(store.read(ref.marker), text)
  assert.equal(fs.existsSync(ref.path), true)

  const reopened = new ArchiveStore({ dir })
  reopened.scan('s1')
  assert.equal(reopened.read(ref.marker), text)
  assert.equal(reopened.list('s1').length, 1)
})

test('queryArchive finds a substring and returns a marker', () => {
  const dir = tempDir()
  const store = new ArchiveStore({ dir })
  const ref = store.save({ sessionId: 's1', content: 'alpha beta gamma ERROR /a/b.ts delta', label: 'grep' })
  const hits = queryArchive(store, 's1', 'error')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].marker, ref.marker)
  assert.match(hits[0].snippet, /ERROR/)
  assert.equal(queryArchive(store, 's1', 'not-there').length, 0)
})

test('queryArchive is session scoped', () => {
  const dir = tempDir()
  const store = new ArchiveStore({ dir })
  store.save({ sessionId: 's1', content: 'shared needle' })
  store.save({ sessionId: 's2', content: 'shared needle' })
  assert.equal(queryArchive(store, 's1', 'needle').length, 1)
})

test('sliceForRecall head/tail/range paginate by cursor', () => {
  const text = 'abcdefghij'
  const head = sliceForRecall(text, { mode: 'head', maxChars: 4 })
  assert.equal(head.content, 'abcd')
  assert.equal(head.nextCursor, 4)

  const range = sliceForRecall(text, { mode: 'range', offset: 4, maxChars: 4 })
  assert.equal(range.content, 'efgh')
  assert.equal(range.nextCursor, 8)

  const tail = sliceForRecall(text, { mode: 'tail', maxChars: 3 })
  assert.equal(tail.content, 'hij')
  assert.equal(tail.nextCursor, 7)

  const rest = sliceForRecall(text, { mode: 'range', offset: 8, maxChars: 10 })
  assert.equal(rest.content, 'ij')
  assert.equal(rest.nextCursor, null)
})

test('purge removes the session directory', () => {
  const dir = tempDir()
  const store = new ArchiveStore({ dir })
  const ref = store.save({ sessionId: 's1', content: 'x' })
  store.purge('s1')
  assert.equal(store.read(ref.marker), null)
  assert.equal(fs.existsSync(path.dirname(ref.path)), false)
})
