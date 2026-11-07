/**
 * Per-window compression ledger.
 *
 * One JSON line per context window (an "epoch": same provider, model, window
 * size and trigger line). The plugin is restarted often, so the ledger is the
 * only way to answer "how much did window N actually save" after a restart.
 *
 * Append-only JSONL under <dir>/<sessionId>.jsonl; the last row for a window id
 * is the freshest snapshot, `closed: true` marks the final one.
 */
import fs from 'node:fs'
import path from 'node:path'

export class WindowLedger {
  constructor(options = {}) {
    this.dir = options.dir || ''
    this.keep = options.keep ?? 40
  }

  file(sessionId) {
    if (!this.dir || !sessionId) return ''
    return path.join(this.dir, `${sessionId}.jsonl`)
  }

  /** Append one window snapshot. Never throws: the ledger must not break a turn. */
  record(sessionId, snapshot) {
    try {
      const file = this.file(sessionId)
      if (!file) return null
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(file, JSON.stringify(snapshot) + '\n', { mode: 0o600 })
      return snapshot
    } catch {
      return null
    }
  }

  /** Recent windows for a session, newest first, deduplicated by window id. */
  recent(sessionId, limit = 8) {
    try {
      const file = this.file(sessionId)
      if (!file || !fs.existsSync(file)) return []
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      const byId = new Map()
      for (const line of lines.slice(-400)) {
        let row
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (!row || !row.windowId) continue
        const previous = byId.get(row.windowId)
        if (!previous || row.at >= previous.at) byId.set(row.windowId, row)
      }
      return [...byId.values()].sort((a, b) => b.openedAt - a.openedAt).slice(0, limit)
    } catch {
      return []
    }
  }
}
