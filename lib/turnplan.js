/**
 * Pure turn-replacement planner. Decides whether a finished turn can be replaced
 * by its card without breaking tool pairing, and reports the exact surface range.
 */

const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

export function isSurfaceEvent(event) {
  return Boolean(event && SURFACE_TYPES.has(event.type))
}

function callIds(event) {
  if (event.type !== 'assistant/message') return []
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return []
  const ids = []
  for (const block of content) {
    if (block && block.type === 'tool-call' && block.id) ids.push(String(block.id))
  }
  return ids
}

function resultId(event) {
  if (event.type !== 'tool/result') return null
  const id = event.data?.message?.toolCallId ?? event.data?.toolCallId
  return id ? String(id) : null
}

export function checkPairing(events) {
  const calls = []
  const results = []
  for (const event of events) {
    calls.push(...callIds(event))
    const id = resultId(event)
    if (id) results.push(id)
  }
  const callSet = new Set(calls)
  const resultSet = new Set(results)
  if (callSet.size !== resultSet.size) return false
  for (const id of callSet) if (!resultSet.has(id)) return false
  for (const id of resultSet) if (!callSet.has(id)) return false
  return calls.length === results.length
}

/**
 * @param {object} input
 * @param {Array} input.events  surface events of one turn, in log order
 * @param {(text: string) => number} [input.price]
 * @param {string} input.card
 * @param {number} [input.minSavingRatio]
 */
export function planTurn({ events, card, price = null, minSavingRatio = 0.1, turn = null }) {
  const surface = (events || []).filter(isSurfaceEvent)
  if (!surface.length) return { ok: false, reason: 'no-surface', turn }
  const startSeq = surface[0].seq
  const endSeq = surface[surface.length - 1].seq
  const balanced = checkPairing(surface)
  const text = surface
    .map(event => {
      if (event.type === 'tool/result') {
        const content = event.data?.message?.content
        if (!Array.isArray(content)) return ''
        return content
          .map(block => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
          .filter(Boolean)
          .join('\n')
      }
      if (
        event.type === 'assistant/message' ||
        event.type === 'user/message' ||
        event.type === 'system/message' ||
        event.type === 'developer/message'
      ) {
        const content = event.data?.message?.content ?? event.data?.content
        if (!Array.isArray(content)) return ''
        return content
          .map(block => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
          .filter(Boolean)
          .join('\n')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')

  const shadowedTokens = price ? price(text) : text.length
  const cardTokens = price ? price(card) : (card || '').length
  const saving = shadowedTokens - cardTokens
  const ratio = shadowedTokens > 0 ? saving / shadowedTokens : 0
  const ok = balanced && Boolean(card) && saving > 0 && ratio >= minSavingRatio
  return {
    ok,
    turn,
    startSeq,
    endSeq,
    sourceSeqs: surface.map(event => event.seq),
    surfaceCount: surface.length,
    balanced,
    shadowedTokens,
    cardTokens,
    saving,
    ratio,
    reason: ok ? 'ok' : !balanced ? 'pairing' : !card ? 'no-card' : 'no-gain',
  }
}
