/**
 * State board: a small, derived, merge-only summary that never replaces the anchor.
 * Pure functions; the host owns persistence and injection.
 */

import { anchorLines, collectHardFactsGrouped } from './transform.js'

export function createBoard() {
  return {
    goals: [],
    constraints: [],
    decisions: [],
    files: [],
    errors: [],
    open: [],
    next: '',
    archiveRefs: [],
    updatedAt: 0,
  }
}

function pushUnique(list, value, limit) {
  if (!value) return
  if (!list.includes(value)) list.push(value)
  if (list.length > limit) list.splice(0, list.length - limit)
}

export function mergeBoard(board, update = {}, at = Date.now()) {
  const next = {
    goals: [...board.goals],
    constraints: [...board.constraints],
    decisions: [...board.decisions],
    files: [...board.files],
    errors: [...board.errors],
    open: [...board.open],
    next: board.next,
    archiveRefs: [...board.archiveRefs],
    updatedAt: at,
  }
  if (update.goal) {
    const last = next.goals[next.goals.length - 1]
    if (!last || last.text !== update.goal) next.goals.push({ text: update.goal, at })
    if (next.goals.length > 2) next.goals.splice(0, next.goals.length - 2)
  }
  for (const constraint of update.constraints ?? []) pushUnique(next.constraints, constraint, 30)
  for (const decision of update.decisions ?? []) {
    if (!next.decisions.some(d => d.text === decision)) next.decisions.push({ text: decision, at })
  }
  if (next.decisions.length > 20) next.decisions.splice(0, next.decisions.length - 20)
  if (update.files) next.files = update.files.slice(-10)
  if (update.errors) next.errors = update.errors.slice(-5)
  for (const item of update.open ?? []) {
    const existing = next.open.find(o => o.id === item.id)
    if (existing) Object.assign(existing, item, { at })
    else next.open.push({ status: 'open', ...item, at })
  }
  if (next.open.length > 20) next.open.splice(0, next.open.length - 20)
  if (update.close) {
    for (const id of update.close) {
      const existing = next.open.find(o => o.id === id)
      if (existing) existing.status = 'done'
    }
  }
  if (typeof update.next === 'string') next.next = update.next
  for (const ref of update.archiveRefs ?? []) pushUnique(next.archiveRefs, ref, 10)
  return next
}

export function renderBoard(board, options = {}) {
  const maxTokens = options.maxTokens ?? 2048
  const maxChars = maxTokens * 4
  const parts = []
  const goal = board.goals[board.goals.length - 1]
  if (goal) parts.push(`Goal: ${goal.text}`)
  if (board.goals.length > 1) {
    parts.push(`Previous goal: ${board.goals[0].text}`)
  }
  if (board.constraints.length) {
    parts.push('Constraints:')
    for (const constraint of board.constraints) parts.push(`- ${constraint}`)
  }
  if (board.decisions.length) {
    parts.push('Decisions:')
    for (const decision of board.decisions) parts.push(`- ${decision.text}`)
  }
  if (board.files.length) parts.push(`Files: ${board.files.join(', ')}`)
  if (board.errors.length) parts.push(`Errors: ${board.errors.join(' | ')}`)
  const openItems = board.open.filter(item => item.status !== 'done')
  if (openItems.length) {
    parts.push('Open:')
    for (const item of openItems) parts.push(`- ${item.text}`)
  }
  const doneItems = board.open.filter(item => item.status === 'done')
  if (doneItems.length) parts.push(`Resolved: ${doneItems.map(item => item.text).join('; ')}`)
  if (board.next) parts.push(`Next: ${board.next}`)
  if (board.archiveRefs.length) parts.push(`Archive: ${board.archiveRefs.join(' ')}`)

  let text = parts.join('\n')
  if (text.length <= maxChars) return text

  // Trim least-critical sections first, then hard-truncate.
  const trimmable = [
    () => {
      const index = parts.findIndex(p => p === 'Decisions:')
      if (index >= 0) parts.splice(index, countSection(parts, index))
    },
    () => {
      const index = parts.findIndex(p => p.startsWith('Files:') || p.startsWith('Errors:') || p.startsWith('Archive:'))
      if (index >= 0) parts.splice(index, 1)
    },
  ]
  for (const trim of trimmable) {
    text = parts.join('\n')
    if (text.length <= maxChars) return text
    trim()
  }
  text = parts.join('\n')
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function countSection(parts, start) {
  let count = 1
  while (start + count < parts.length && parts[start + count].startsWith('- ')) count++
  return count
}

/** Seed goal and constraints from the first user message. */
export function seedBoardFromText(board, text, at = Date.now()) {
  const picked = anchorLines(text)
  if (!picked.length) return board
  const constraints = picked
    .filter(line => /(必须|不要|禁止|只能|务必|验收|格式|must|never|required|acceptance|format)/i.test(line))
    .slice(0, 10)
  return mergeBoard(board, { goal: picked[0], constraints }, at)
}

/** Merge one finished turn's files, errors, open items and decisions into the board. */
export function updateBoardFromText(board, text, at = Date.now()) {
  if (!text) return board
  try {
    const grouped = collectHardFactsGrouped(text)
    const lines = text.split('\n')
    const open = []
    for (const line of lines) {
      if (open.length >= 5) break
      const trimmed = line.trim()
      if (!trimmed || trimmed.length > 200) continue
      if (/(TODO|FIXME|blocked|待确认|未完成)/i.test(trimmed)) {
        open.push({ id: hashLine(trimmed), text: trimmed })
      }
    }
    const decisions = []
    for (const line of lines) {
      if (decisions.length >= 3) break
      const trimmed = line.trim()
      if (trimmed && trimmed.length <= 200 && /(决定|采用|选择|confirmed|decided)/i.test(trimmed)) {
        decisions.push(trimmed)
      }
    }
    return mergeBoard(
      board,
      {
        files: [...board.files, ...grouped.paths].slice(-10),
        errors: [...board.errors, ...grouped.errors].slice(-5),
        open,
        decisions,
      },
      at,
    )
  } catch {
    return board
  }
}

function hashLine(text) {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8)
}
