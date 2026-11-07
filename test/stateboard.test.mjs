import test from 'node:test'
import assert from 'node:assert/strict'
import { createBoard, mergeBoard, renderBoard } from '../lib/stateboard.js'

test('merge dedupes constraints and appends decisions', () => {
  let board = createBoard()
  board = mergeBoard(board, { constraint: undefined, constraints: ['必须只读', '必须只读'] }, 1)
  board = mergeBoard(board, { constraints: ['必须只读', '不要改写'], decisions: ['用 spill 落盘'] }, 2)
  board = mergeBoard(board, { decisions: ['用 spill 落盘', '失败开放'] }, 3)
  assert.deepEqual(board.constraints, ['必须只读', '不要改写'])
  assert.equal(board.decisions.length, 2)
  assert.equal(board.decisions[1].text, '失败开放')
})

test('a conflicting goal keeps the previous one visible', () => {
  let board = createBoard()
  board = mergeBoard(board, { goal: '先做测量' }, 1)
  board = mergeBoard(board, { goal: '先做实现' }, 2)
  assert.equal(board.goals.length, 2)
  assert.equal(board.goals[1].text, '先做实现')
})

test('open items close by id and stay as resolved', () => {
  let board = createBoard()
  board = mergeBoard(board, { open: [{ id: 'q4', text: '状态板用 system 还是 user' }] }, 1)
  board = mergeBoard(board, { close: ['q4'] }, 2)
  assert.equal(board.open.length, 1)
  assert.equal(board.open[0].status, 'done')
  const text = renderBoard(board, { maxTokens: 2048 })
  assert.match(text, /Resolved:/)
})

test('render stays inside the token budget and trims decisions first', () => {
  let board = createBoard()
  board = mergeBoard(
    board,
    {
      goal: '一个很长的目标',
      constraints: Array.from({ length: 30 }, (_, i) => `约束 ${i}：必须保持逐字，不能改写，不能省略，不能猜测`),
      decisions: Array.from({ length: 20 }, (_, i) => `决策 ${i}：${'x'.repeat(80)}`),
    },
    1,
  )
  const text = renderBoard(board, { maxTokens: 200 })
  assert.ok(text.length <= 200 * 4)
  assert.match(text, /Goal:/)
})

test('archive refs are capped at ten', () => {
  let board = createBoard()
  board = mergeBoard(board, { archiveRefs: Array.from({ length: 15 }, (_, i) => `#density-${String(i).padStart(8, '0')}`) }, 1)
  assert.equal(board.archiveRefs.length, 10)
})
