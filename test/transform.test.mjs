import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anchorLines,
  buildCard,
  codeOutline,
  collectHardFacts,
  compressText,
  contentText,
  diffContext,
  extractFactLines,
  hardFactsPreserved,
  headTail,
  jsonArrayCsv,
  jsonlCsv,
  logSample,
  tableSample,
  withHardFacts,
} from '../lib/transform.js'

function jsonArray(count) {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `item-${i + 1}`, score: (i * 7) % 100 })),
  )
}

function jsonl(count) {
  return Array.from({ length: count }, (_, i) => JSON.stringify({ id: i + 1, path: `/tmp/file-${i + 1}.ts`, ok: true })).join('\n')
}

function markdownTable(rows) {
  const head = '| id | name | value |\n|---|---|---|'
  const body = Array.from({ length: rows }, (_, i) => `| ${i} | name-${i} | ${i * 3} |`)
  return [head, ...body].join('\n')
}

function logLines(count, errorAt) {
  return Array.from({ length: count }, (_, i) => {
    if (i === errorAt) return `2026-11-04T12:00:00Z ERROR worker ${i} failed: ENOENT /data/input-${i}.csv`
    return `2026-11-04T12:00:00Z INFO worker ${i} processed batch ${i}`
  }).join('\n')
}

test('jsonArrayCsv converts uniform scalar rows to CSV', () => {
  const input = jsonArray(20)
  const out = jsonArrayCsv(input)
  assert.ok(out)
  assert.equal(out.method, 'toon')
  assert.equal(out.lossy, false)
  assert.ok(out.text.length < input.length)
  assert.match(out.text, /^id,name,score\n/)
  assert.match(out.text, /20,item-20,33/)
})

test('jsonArrayCsv refuses nested objects', () => {
  const input = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: i, nested: { a: 1 } })))
  assert.equal(jsonArrayCsv(input), null)
})

test('jsonlCsv converts NDJSON rows', () => {
  const input = jsonl(15)
  const out = jsonlCsv(input)
  assert.ok(out)
  assert.equal(out.method, 'jsonl')
  assert.ok(out.text.length < input.length)
  assert.match(out.text, /^id,path,ok\n/)
})

test('jsonlCsv refuses mixed keys', () => {
  const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify(i === 5 ? { id: i, other: 1 } : { id: i, path: 'x' }))
  assert.equal(jsonlCsv(lines.join('\n')), null)
})

test('tableSample keeps head and tail with an omission marker', () => {
  const input = markdownTable(30)
  const out = tableSample(input)
  assert.ok(out)
  assert.equal(out.method, 'table')
  assert.equal(out.lossy, true)
  assert.match(out.text, /行省略/)
  assert.match(out.text, /\| 0 \| name-0 \| 0 \|/)
  assert.match(out.text, /\| 29 \| name-29 \| 87 \|/)
  assert.ok(out.text.length < input.length)
})

test('tableSample refuses small tables', () => {
  assert.equal(tableSample(markdownTable(3)), null)
})

test('logSample keeps error lines and their neighbours', () => {
  const input = logLines(90, 40)
  const out = logSample(input)
  assert.ok(out)
  assert.equal(out.method, 'log')
  assert.match(out.text, /ERROR worker 40 failed/)
  assert.match(out.text, /INFO worker 39/)
  assert.match(out.text, /INFO worker 41/)
  assert.ok(out.text.length < input.length)
})

test('logSample returns null when every line is a hit', () => {
  const input = Array.from({ length: 70 }, (_, i) => `ERROR line ${i}`).join('\n')
  assert.equal(logSample(input), null)
})

test('headTail keeps head and tail of long plain text', () => {
  const input = Array.from({ length: 200 }, (_, i) => `line ${i} with some payload`).join('\n')
  const out = headTail(input)
  assert.ok(out)
  assert.equal(out.method, 'headtail')
  assert.match(out.text, /line 0 /)
  assert.match(out.text, /line 199 /)
  assert.match(out.text, /行省略/)
})

test('headTail refuses short text', () => {
  assert.equal(headTail('a\nb\nc'), null)
})

test('compressText picks the first viable transform and never grows', () => {
  const json = jsonArray(30)
  const out = compressText(json)
  assert.ok(out)
  assert.equal(out.method, 'toon')
  assert.ok(out.text.length < json.length)

  const short = 'hello world'
  assert.equal(compressText(short), null)
})

test('compressText respects minBytes', () => {
  const json = jsonArray(30)
  assert.equal(compressText(json, { minBytes: json.length + 1 }), null)
})

test('hard facts survive table sampling when they sit in kept rows', () => {
  const input = markdownTable(30)
  const out = tableSample(input)
  assert.ok(out)
  assert.equal(hardFactsPreserved(input, out.text), true)
})

test('hard facts are detected and a dropped path fails the gate', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} payload`)
  lines[100] = 'see /srv/important/config.yaml for details'
  const input = lines.join('\n')
  const out = headTail(input)
  assert.ok(out)
  assert.ok(collectHardFacts(input).includes('/srv/important/config.yaml'))
  assert.equal(hardFactsPreserved(input, out.text), false)
})

test('extractFactLines keeps paths, errors and constraints', () => {
  const text = [
    '普通说明文字，不该保留的段落。',
    '修改 src/app/main.ts 的入口',
    'ERROR ENOENT /data/missing.csv',
    '必须保持输出格式为 JSON',
    '运行 npm run build',
  ].join('\n')
  const facts = extractFactLines(text)
  assert.match(facts, /src\/app\/main\.ts/)
  assert.match(facts, /ERROR ENOENT/)
  assert.match(facts, /必须保持输出格式/)
  assert.match(facts, /npm run build/)
  assert.doesNotMatch(facts, /普通说明文字/)
})

test('contentText unwraps persisted tool-result blocks', () => {
  const content = [
    { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'inner text' }] },
    { type: 'text', text: 'outer text' },
  ]
  assert.equal(contentText(content), 'inner text\nouter text')
  assert.equal(contentText(undefined), '')
})

test('buildCard keeps every hard fact and stays small', () => {
  const text = [
    ...Array.from({ length: 400 }, () => '普通实现细节说明，没有需要保留的内容。'),
    '修改 src/app/main.ts 与 /srv/config/app.yaml',
    'ERROR ENOENT /data/missing.csv',
    '运行 npm run build 后升级到 v2.13.4',
    '参考 https://example.com/docs/density',
    '必须保持输出格式为 JSON',
  ].join('\n')
  const card = buildCard(text)
  assert.ok(card.length * 20 < text.length)
  assert.equal(hardFactsPreserved(text, card), true)
  assert.match(card, /Files:/)
  assert.match(card, /Cmds:/)
  assert.match(card, /Errors:/)
  assert.match(card, /Rules:/)
})

test('withHardFacts re-attaches dropped paths so the gate passes', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} payload`)
  lines[100] = 'see /srv/important/config.yaml for details'
  const input = lines.join('\n')
  const out = headTail(input)
  assert.ok(out)
  assert.equal(hardFactsPreserved(input, out.text), false)
  const filled = withHardFacts(input, out.text)
  assert.match(filled, /\[硬事实 1 条\]/)
  assert.match(filled, /\/srv\/important\/config\.yaml/)
  assert.equal(hardFactsPreserved(input, filled), true)
  assert.ok(filled.length < input.length)
})

test('diffContext drops unchanged context and keeps the changed lines', () => {
  const context = Array.from({ length: 10 }, (_, i) => ` context line ${i}`)
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 3d1f2a..8b9c0d 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,7 +10,8 @@ export function run() {',
    ...context.slice(0, 5),
    '-  return oldValue',
    '+  return newValue',
    '+  // 新增注释',
    ...context.slice(5),
  ].join('\n')
  const out = diffContext(diff)
  assert.ok(out)
  assert.equal(out.method, 'diff')
  assert.match(out.text, /\+  return newValue/)
  assert.match(out.text, /-  return oldValue/)
  assert.match(out.text, /@@ -10,7 \+10,8 @@/)
  assert.doesNotMatch(out.text, /context line 0/)
  assert.match(out.text, /未变更上下文/)
  assert.ok(out.text.length < diff.length)
  assert.equal(compressText(diff).method, 'diff')
})

test('tableSample handles a 12-row table now that the floor is 8', () => {
  const input = markdownTable(12)
  const out = tableSample(input)
  assert.ok(out)
  assert.ok(out.text.length < input.length)
  assert.match(out.text, /行省略/)
})

test('jsonArrayCsv accepts a 6-row array', () => {
  const input = jsonArray(6)
  const out = compressText(input)
  assert.ok(out)
  assert.equal(out.method, 'toon')
  assert.ok(out.text.length < input.length)
})

test('anchorLines keeps leading intent plus constraints', () => {
  const text = [
    '做一个插件',
    '细节一',
    '细节二',
    ...Array.from({ length: 12 }, (_, i) => `说明 ${i}`),
    '必须保持只读',
    'never rewrite history',
  ].join('\n')
  const anchors = anchorLines(text)
  assert.equal(anchors[0], '做一个插件')
  assert.ok(anchors.includes('必须保持只读'))
  assert.ok(anchors.includes('never rewrite history'))
  assert.ok(anchors.length <= 40)
})

test('compressText passes numeric row budgets to sample transforms', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i} ${'x'.repeat(10)}`)
  const out = compressText(lines.join('\n'), { policy: 'aggressive' })
  assert.ok(out)
  assert.ok(!/NaN/.test(out.text), 'no NaN in omission marker')
  assert.match(out.text, /^line 0/, 'head is kept')
})

test('a table compressed through compressText keeps its header row', () => {
  const input = markdownTable(30)
  const out = compressText(input, { policy: 'aggressive' })
  assert.ok(out)
  assert.match(out.text, /^\| id \| name \| value \|/)
})

test('quality policy leaves table rows and generic long text alone', () => {
  assert.equal(compressText(markdownTable(30)), null)
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i} ${'x'.repeat(10)}`)
  assert.equal(compressText(lines.join('\n')), null)
})

test('quality policy keeps value-preserving transforms', () => {
  const json = jsonArray(30)
  assert.equal(compressText(json).method, 'toon')
  const code = [
    '#include <linux/sched.h>',
    'static int helper(int x)',
    'int main(void)',
    ...Array.from({ length: 90 }, (_, i) => `  int local_${i} = step(${i});`),
  ].join('\n')
  assert.equal(compressText(code), null, 'quality mode leaves code untouched')
})

test('log sampling carries aggregate counts for lost rows', () => {
  const lines = []
  for (let i = 0; i < 80; i++) {
    const isError = i === 40 || i === 60
    lines.push(
      isError
        ? `2026-11-06T09:00:00.000Z ERROR req=${i} /api/pay status=500 latency=12ms`
        : `2026-11-06T09:00:00.000Z INFO req=${i} /api/pay status=200 latency=12ms`,
    )
  }
  const out = logSample(lines.join('\n'))
  assert.ok(out)
  assert.match(out.text, /\[统计\]/)
  assert.match(out.text, /status500=2/)
  assert.match(out.text, /status200=78/)
})

test('log sampling refuses prose that merely mentions errors', () => {
  const prose = Array.from({ length: 80 }, (_, i) =>
    i % 20 === 7 ? `note ${i}: this step failed again, nothing to see` : `note ${i}: an ordinary paragraph, unrelated to logs`,
  ).join('\n')
  assert.equal(logSample(prose), null)
  const out = compressText(prose)
  assert.ok(!out || out.method !== 'log')
})

test('log sampling still accepts real log lines', () => {
  const out = logSample(logLines(120, 60))
  assert.ok(out)
  assert.equal(out.method, 'log')
})

test('codeOutline keeps declarations and drops bodies', () => {
  const body = Array.from({ length: 120 }, (_, i) => `  int local_${i} = compute_step(${i});`)
  const code = ['#include <linux/sched.h>', 'struct task_struct;', 'static int helper(int x);', ...body, 'int main(void)', '{', '  return 0;', '}'].join('\n')
  const out = codeOutline(code)
  assert.ok(out)
  assert.equal(out.method, 'code-outline')
  assert.match(out.text, /#include <linux\/sched.h>/)
  assert.match(out.text, /static int helper\(int x\);/)
  assert.doesNotMatch(out.text, /local_7 /)
  assert.ok(out.text.length < code.length)
  assert.equal(compressText(code, { policy: 'aggressive' }).method, 'code-outline')
})

test('long Chinese prose is not sampled into headTail', () => {
  const prose = Array.from({ length: 200 }, (_, i) => `第 ${i} 段：他走进院子，看见窗下的梅花开了，心里忽然一阵难过。`).join('\n')
  assert.equal(headTail(prose), null)
  assert.equal(compressText(prose), null)
})

test('codeOutline recognises read-tool gutter prefixes', () => {
  const body = Array.from({ length: 100 }, (_, i) => `${3000 + i}: \tint local_${i} = step_${i}(x);`)
  const code = ['3000: #include <linux/sched.h>', '3001: static int helper(int x)', '3002: {', ...body, '3200: int main(void)'].join('\n')
  const out = codeOutline(code)
  assert.ok(out)
  assert.equal(out.method, 'code-outline')
  assert.match(out.text, /int main/)
  assert.match(out.text, /#include <linux\/sched.h>/)
})

test('comment openers are not path facts', () => {
  const text = '/* license header */\n#include <stdio.h>\nsee /srv/app/main.c and C:\\work\\x.log'
  const facts = collectHardFacts(text)
  assert.ok(!facts.includes('/*'))
  assert.ok(facts.includes('/srv/app/main.c'))
})

test('codeOutline keeps top-level structs and drops indented locals', () => {
  const body = Array.from({ length: 80 }, (_, i) => `  int local_${i} = step(${i});`)
  const code = [
    'struct rq_flags {',
    '  int flags;',
    '};',
    'static int helper(struct rq *rq)',
    '{',
    '  struct task_struct *push_task = NULL;',
    ...body,
    '  return 0;',
    '}',
    'int main(void)',
  ].join('\n')
  const out = codeOutline(code)
  assert.ok(out)
  assert.match(out.text, /struct rq_flags/)
  assert.match(out.text, /static int helper/)
  assert.doesNotMatch(out.text, /push_task = NULL/)
})

test('log sampling recognises read-tool gutter prefixes', () => {
  const lines = Array.from({ length: 80 }, (_, i) =>
    `${i + 1}: 2026-11-06T09:00:00.000Z ${i === 40 ? 'ERROR' : 'INFO'} req=${i} /api/pay status=${i === 40 ? 500 : 200} latency=12ms`,
  ).join('\n')
  const out = logSample(lines)
  assert.ok(out)
  assert.equal(out.method, 'log')
  assert.match(out.text, /status500=1/)
})

test('json transforms tolerate read-tool gutter prefixes', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}`, score: (i * 7) % 100 }))
  const pretty = JSON.stringify(rows, null, 2)
  const gutted = pretty.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n')
  const out = compressText(gutted)
  assert.ok(out)
  assert.equal(out.method, 'toon')
  assert.ok(out.text.length < gutted.length)
})
