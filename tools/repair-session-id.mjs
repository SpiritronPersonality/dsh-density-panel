#!/usr/bin/env node
/**
 * Repair sessions whose user/message events are missing `data.id` (DSH refuses
 * to load them: "session event at seq N lacks an identified message").
 *
 * The density plugin used to append its re-anchor / turn-card messages without
 * an id (fixed in v31). This tool patches already-written logs.
 *
 * usage:
 *   node tools/repair-session-id.mjs --file <session.v4.jsonl.zstd>          # dry run
 *   node tools/repair-session-id.mjs --file <session.v4.jsonl.zstd> --apply  # backup + rewrite
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : null
const apply = args.includes('--apply')
if (!file) {
  console.error('usage: node tools/repair-session-id.mjs --file <session.v4.jsonl.zstd> [--apply]')
  process.exit(2)
}

const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const raw = fs.readFileSync(file)
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
    events.push(...zlib.zstdDecompressSync(raw.subarray(off, end)).toString('utf8').split('\n').filter(Boolean))
  } catch {
    // keep going: a torn frame must not stop the scan of the rest of the log
  }
  off = end
}

const bad = []
const out = []
for (const line of events) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    out.push(line)
    continue
  }
  if (event.type === 'user/message' && !event.data?.id) {
    bad.push({ seq: event.seq, head: String(event.data?.content?.[0]?.text || '').slice(0, 60) })
    event.data = { id: crypto.randomUUID(), ...event.data }
    out.push(JSON.stringify(event))
    continue
  }
  out.push(line)
}

console.log(`events=${out.length} missing-id=${bad.length}`)
for (const b of bad) console.log(`  seq ${b.seq}: ${b.head.replace(/\n/g, ' ')}`)

if (!bad.length) {
  console.log('nothing to repair')
  process.exit(0)
}
if (!apply) {
  console.log('dry run only; re-run with --apply to rewrite (a .bak file is created)')
  process.exit(0)
}

const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
fs.copyFileSync(file, backup)
const tmp = `${file}.tmp`
const fd = fs.openSync(tmp, 'w')
for (const line of out) fs.writeSync(fd, zlib.zstdCompressSync(Buffer.from(line + '\n', 'utf8')))
fs.closeSync(fd)
fs.renameSync(tmp, file)
console.log(`repaired ${bad.length} event(s); backup: ${backup}`)
