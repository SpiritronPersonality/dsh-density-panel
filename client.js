window.__ModuleLoader__.load({
  id: '@local/density-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 只使用 DSH 设计系统里已存在的语义 token（--dsw-alias-* / --dsw-radius-*），
    // 浅色与深色由主题自动解析，因此面板不写任何具体色值。
    const T = {
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      dim: 'var(--dsw-alias-label-tertiary)',
      faint: 'var(--dsw-alias-label-caption)',
      line: 'var(--dsw-alias-border-l1)',
      line2: 'var(--dsw-alias-border-l2)',
      card: 'var(--dsw-alias-bg-module-platform)',
      track: 'var(--dsw-alias-bg-base)',
      brand: 'var(--dsw-alias-state-business-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    }

    function fmt(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—'
      const abs = Math.abs(n)
      if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(Math.round(n))
    }

    function pct(v) {
      return typeof v === 'number' && isFinite(v) ? (v * 100).toFixed(1) + '%' : '—'
    }

    function clock(ms) {
      try {
        return new Date(ms || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })
      } catch {
        return ''
      }
    }

    function pressureColor(p) {
      if (typeof p !== 'number') return T.dim
      if (p >= 0.8) return T.err
      if (p >= 0.65) return T.warn
      return T.ok
    }

    function Card(props) {
      return h(
        'section',
        {
          style: {
            background: T.card,
            border: `1px solid ${T.line}`,
            borderRadius: 'var(--dsw-radius-lg)',
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          h('div', { style: { fontSize: 12, lineHeight: '18px', color: T.dim } }, props.title),
          props.aside ? h('div', { style: { fontSize: 12, color: T.dim } }, props.aside) : null,
        ),
        props.children,
      )
    }

    function Row(props) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } },
        h('span', { style: { fontSize: 12, lineHeight: '18px', color: T.sub, minWidth: 0 } }, props.label),
        h(
          'span',
          {
            style: {
              fontSize: 12,
              lineHeight: '18px',
              color: props.muted ? T.dim : T.text,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'right',
              whiteSpace: 'nowrap',
            },
          },
          props.value,
        ),
      )
    }

    function Stat(props) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: T.dim } }, props.label),
        h(
          'div',
          {
            style: {
              fontSize: 15,
              lineHeight: '22px',
              fontWeight: 600,
              color: T.text,
              fontVariantNumeric: 'tabular-nums',
            },
          },
          props.value,
        ),
      )
    }

    function Badge(props) {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            lineHeight: '16px',
            color: props.color || T.sub,
            border: `1px solid ${T.line2}`,
            borderRadius: 999,
            padding: '1px 8px',
            whiteSpace: 'nowrap',
          },
        },
        props.dot ? h('span', { style: { width: 5, height: 5, borderRadius: 999, background: props.dot } }) : null,
        props.children,
      )
    }

    function DensityIcon(props) {
      const size = props && props.size ? props.size : 20
      const active = props && props.active
      const stroke = active ? T.brand : T.sub
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 17a8 8 0 0 1 16 0' }),
        h('path', { d: 'M12 17l4.2-4.6' }),
        h('circle', { cx: 12, cy: 17, r: 1.3, fill: stroke, stroke: 'none' }),
      )
    }

    function DensityPanel(props) {
      const seed = props && props.initialData ? props.initialData : null
      const [data, setData] = React.useState(seed)
      const [error, setError] = React.useState(null)
      const [picked, setPicked] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        let timer = null
        async function tick() {
          try {
            const res = await fetch('/density/snapshot', {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const json = await res.json()
            if (!alive) return
            setData(json)
            setError(null)
          } catch (e) {
            if (alive) setError(String((e && e.message) || e))
          }
          if (alive) timer = setTimeout(tick, 2000)
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [])

      const sessions = (data && data.sessions) || []
      const index = Math.min(picked, Math.max(0, sessions.length - 1))
      const s = sessions[index]

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          h('div', { style: { fontSize: 16, lineHeight: '24px', fontWeight: 600, color: T.text } }, '上下文密度'),
          h('div', { style: { fontSize: 12, lineHeight: '18px', color: T.dim } }, '只读观测 · 不参与改写'),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 } },
          h(Badge, { dot: error ? T.err : T.ok }, error ? '连接异常' : '实时'),
        ),
      )

      if (!s) {
        return h(
          'div',
          {
            style: {
              height: '100%',
              overflow: 'auto',
              padding: '20px 24px',
              color: T.text,
              fontSize: 13,
              background: 'var(--dsw-alias-bg-base)',
            },
          },
          header,
          h(
            'div',
            {
              style: {
                marginTop: 16,
                padding: '28px 16px',
                textAlign: 'center',
                fontSize: 12,
                color: T.dim,
                border: `1px dashed ${T.line2}`,
                borderRadius: 'var(--dsw-radius-lg)',
              },
            },
            error ? `读取失败：${error}` : '打开一个会话后开始测量。',
          ),
        )
      }

      const layers = s.layers || {}
      const saved = s.saved || {}
      const anchors = s.anchors || {}
      const board = s.board || {}
      const repl = s.replacement || {}
      const win = s.window
      const trigger = s.trigger
      const pressure = s.pressure
      const pColor = pressureColor(pressure)

      const track = (children, caption) =>
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                height: 6,
                borderRadius: 999,
                overflow: 'hidden',
                background: T.track,
                boxShadow: `inset 0 0 0 1px ${T.line}`,
              },
            },
            children,
          ),
          caption
            ? h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: T.dim } }, caption)
            : null,
        )

      const ratioBadge = () => {
        const ratio = saved.ratio
        if (ratio === null || typeof ratio !== 'number') {
          return h(Badge, { color: T.dim }, win ? '基线不足' : '窗口未知')
        }
        return h(Badge, { color: ratio < 0 ? T.err : T.ok }, `净省占全部输入 ${pct(ratio)}`)
      }

      const netValue = typeof saved.net === 'number' ? saved.net : null

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflow: 'auto',
            background: 'var(--dsw-alias-bg-base)',
            color: T.text,
            fontSize: 13,
          },
        },
        h(
          'div',
          {
            style: {
              maxWidth: 720,
              margin: '0 auto',
              padding: '20px 24px 32px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            },
          },
          header,

          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: T.sub } },
            h('span', { style: { color: T.text } }, `${s.provider || '未知提供方'} / ${s.model || '未知模型'}`),
            h('span', { style: { color: T.faint } }, '·'),
            h('span', null, `上下文窗口 ${win ? fmt(win) : '未知'}`),
            h('span', { style: { color: T.faint } }, '·'),
            h('span', null, `第 ${s.epochCount || 1} 个周期`),
          ),

          sessions.length > 1
            ? h(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                sessions.map((item, i) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      type: 'button',
                      onClick: () => setPicked(i),
                      style: {
                        fontSize: 11,
                        lineHeight: '16px',
                        padding: '3px 10px',
                        borderRadius: 999,
                        cursor: 'pointer',
                        color: i === index ? T.text : T.sub,
                        background: i === index ? T.card : 'transparent',
                        border: `1px solid ${i === index ? T.line2 : T.line}`,
                      },
                    },
                    `${item.model || '会话'} · ${String(item.id).slice(-4)}`,
                  ),
                ),
              )
            : null,

          // 1 · 容量与触发线：压力卡的分母，放在上面
          h(
            Card,
            { title: '容量与触发线', aside: s.noFallback ? h(Badge, { color: T.warn }, '无兜底') : null },
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 } },
              h(Stat, { label: '上下文窗口', value: win ? fmt(win) : '未知' }),
              h(Stat, { label: '压缩触发线', value: trigger ? fmt(trigger) : '未知' }),
              h(Stat, { label: '输出预留', value: fmt(s.output) }),
              h(Stat, { label: '原生安全余量', value: fmt(s.headroom) }),
            ),
            s.noFallback
              ? h(
                  'div',
                  { style: { fontSize: 11, lineHeight: '16px', color: T.warn } },
                  '该窗口没有主动压缩兜底，只剩溢出恢复。',
                )
              : h(
                  'div',
                  { style: { fontSize: 11, lineHeight: '16px', color: T.dim } },
                  '触发线 = min(窗口 × 80%, 窗口 − 输出预留 − 安全余量)，压力按这条线计算。',
                ),
          ),

          // 2 · 压力：与上面的触发线同一条轴
          h(
            Card,
            { title: '当前压力', aside: h('span', { style: { fontSize: 11, color: T.dim } }, `${fmt(s.surfaceTokens)} / ${trigger ? fmt(trigger) : '—'}`) },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
              h(
                'div',
                { style: { fontSize: 26, lineHeight: '32px', fontWeight: 600, color: pColor, fontVariantNumeric: 'tabular-nums' } },
                pct(pressure),
              ),
              h('div', { style: { fontSize: 12, color: T.dim } }, '已用触发线的'),
            ),
            track(
              [
                h('div', {
                  key: 'anchor',
                  style: {
                    width: `${trigger ? Math.min(100, ((layers.anchor || 0) / trigger) * 100) : 0}%`,
                    background: T.faint,
                    height: '100%',
                  },
                }),
                h('div', {
                  key: 'work',
                  style: {
                    width: `${trigger ? Math.min(100, ((layers.working || 0) / trigger) * 100) : 0}%`,
                    background: pColor,
                    height: '100%',
                  },
                }),
              ],
              [
                h('span', { key: 'a' }, `锚点 ${fmt(layers.anchor)}`),
                h('span', { key: 'w' }, `工作 ${fmt(layers.working)}`),
                h('span', { key: 'r' }, `余量 ${fmt(layers.reserve)}`),
                typeof layers.archive === 'number' && layers.archive > 0
                  ? h('span', { key: 'z' }, `归档 ${fmt(layers.archive)}`)
                  : null,
              ],
            ),
          ),

          // 3 · 节省：净额是这条链的结果
          h(
            Card,
            { title: '节省（相对全部输入）', aside: ratioBadge() },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
              h(
                'div',
                {
                  style: {
                    fontSize: 26,
                    lineHeight: '32px',
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    color: netValue === null ? T.text : netValue < 0 ? T.err : T.text,
                  },
                },
                netValue === null ? '—' : `${netValue > 0 ? '+' : ''}${fmt(netValue)}`,
              ),
              h('div', { style: { fontSize: 12, color: T.dim } }, '净额 token'),
            ),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h(Row, { label: '携带节省', value: fmt(saved.carried) }),
              h(Row, { label: '扣减（状态板 + 召回）', value: fmt(-(saved.overhead || 0)), muted: true }),
              h(Row, { label: '入口改写 / 轮末卡片', value: `${saved.entryCount || 0} 条 / ${saved.turnCount || 0} 条`, muted: true }),
              h(Row, { label: '全部输入 token', value: fmt(saved.baseline), muted: true }),
            ),
          ),

          // 4 · 承载：压缩后留下什么
          h(
            Card,
            { title: '承载（状态板与轮次卡）', aside: h('span', { style: { fontSize: 11, color: T.dim } }, `${repl.appliedTurns || 0} 轮已替换`) },
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } },
              h(Stat, { label: '目标 / 约束', value: `${board.goal ? 1 : 0} / ${board.constraints || 0}` }),
              h(Stat, { label: '文件 / 错误', value: `${board.files || 0} / ${board.errors || 0}` }),
              h(Stat, { label: '待办', value: String(board.open || 0) }),
            ),
            h(Row, {
              label: '最近一次轮次卡',
              value: repl.lastPlan
                ? `${fmt(repl.lastPlan.saving)} · ${pct(repl.lastPlan.ratio)}${repl.lastPlan.ok ? '' : ' · 未采用'}`
                : '尚未生成',
              muted: true,
            }),
            h(
              'div',
              { style: { fontSize: 11, lineHeight: '16px', color: T.dim } },
              repl.replaceErrors
                ? `替换失败 ${repl.replaceErrors} 次${repl.replaceError ? `：${repl.replaceError}` : ''}`
                : '每轮用一张抽取卡替换当轮原文，锚点与配对校验不通过时原样放行。',
            ),
          ),

          // 4.5 · 窗口账本：每个上下文窗口的压缩记录（重启后仍在）
          h(
            Card,
            {
              title: '窗口账本',
              aside: h(
                'span',
                { style: { fontSize: 11, color: T.dim } },
                `${(s.windows || []).length} 个窗口已记录`,
              ),
            },
            (() => {
              const rows = (s.windows || []).slice(0, 5)
              if (!rows.length) {
                return h('div', { style: { fontSize: 11, color: T.dim } }, '本窗口的账本将在第一次 15 秒刷新或轮次结束时落盘。')
              }
              return h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                rows.map(w =>
                  h(
                    'div',
                    {
                      key: w.windowId,
                      style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, color: T.sub },
                    },
                    h('span', null, `${String(w.windowId).slice(0, 6)} · ${w.closed ? '已关闭' : '进行中'}`),
                    h(
                      'span',
                      { style: { fontVariantNumeric: 'tabular-nums' } },
                      `入口 ${w.entries} · 省 ${fmt(w.entrySaved)} · 峰值 ${fmt(w.pressurePeak)}`,
                    ),
                  ),
                ),
              )
            })(),
            h(
              'div',
              { style: { fontSize: 11, lineHeight: '16px', color: T.dim } },
              '每个窗口独立记账，写入 ~/.density/windows/<会话>.jsonl，重启后仍可回看。',
            ),
          ),

          // 5 · 不能丢的东西
          h(
            Card,
            { title: '锚点与归档', aside: h('span', { style: { fontSize: 11, color: T.dim } }, `${anchors.count || 0} 条`) },
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 } },
              h(Stat, { label: '锚点 token', value: fmt(anchors.tokens) }),
              h(Stat, { label: '指纹', value: anchors.hash || '—' }),
            ),
            h(
              'div',
              { style: { fontSize: 11, lineHeight: '16px', color: T.dim } },
              '锚点原文不进入压缩，只做逐字保留；召回质量需人工标注集，暂不显示。',
            ),
          ),

          // 6 · 独立复算：不经插件口径的第二意见
          s.mirror
            ? h(
                Card,
                {
                  title: '文本对照（独立复算）',
                  aside: h('span', { style: { fontSize: 11, color: T.dim } }, `${s.mirror.messages || 0} 条消息`),
                },
                h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } },
                  h(Stat, { label: '原文 token', value: fmt(s.mirror.rawTokens) }),
                  h(Stat, { label: '实际 token', value: fmt(s.mirror.actualTokens) }),
                  h(Stat, { label: '节省', value: `${fmt(s.mirror.savedTokens)} · ${pct(s.mirror.ratio)}` }),
                ),
                h(
                  'div',
                  { style: { fontSize: 11, lineHeight: '16px', color: T.dim } },
                  '由会话重建的文本快照，不经过插件自己的计数口径。',
                ),
              )
            : null,

          // 7 · 原生压缩
          h(
            Card,
            { title: '原生压缩', aside: h('span', { style: { fontSize: 11, color: T.dim } }, `${s.compactions || 0} 次`) },
            h(Row, { label: '最近一次触发时的占用', value: s.lastCompactionSurface ? fmt(s.lastCompactionSurface) : '尚未触发' }),
          ),

          h(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                paddingTop: 4,
                fontSize: 11,
                lineHeight: '16px',
                color: T.dim,
              },
            },
            h(
              'div',
              null,
              `读法：窗口 → 触发线 → 压力 → 压缩 → 节省；锚点是压缩的边界，文本对照是独立复算。`,
            ),
            h(
              'div',
              null,
              error
                ? `刷新失败：${error}`
                : `${s.requests || 0} 次请求 · ${clock(s.updatedAt)} 更新 · 每 2 秒刷新 · 面板 v${(data && data.v) || '?'}`,
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'density', order: 20, label: '密度' },
            DensityIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'density' }, DensityPanel),
        )
      },
    }
  },
})
