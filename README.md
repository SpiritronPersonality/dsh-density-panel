# Density — quality-first context compression for DSH

A DSH client plugin that compresses **only the tool output it can compress without losing
answers**, archives the originals, and keeps a per-context-window ledger of what it saved.

It is deliberately conservative: the goal is information density (remove noise), not a
smaller token bill. Token savings are a side effect.

## What it does — and what it refuses to do

| Input | Action | Why |
|---|---|---|
| JSON / JSONL arrays | convert to CSV (every value kept) | lossless in practice; 5/5 in blind tests |
| Unified diffs | drop unchanged context lines | changed lines and hunk headers stay |
| Logs | keep head, tail, every error line, plus a `[统计]` aggregate line | counts stay answerable after sampling |
| Tables | **never compressed** | row sampling destroyed 5 of 6 answers in testing |
| Prose / long text | **never compressed** | sampling a narrative is data loss, not a summary |
| Source code | **never compressed** (v30+) | reviewers always recalled the outline; the round trip cost more than it saved |
| `cairn_*`, `density_recall` output | **never touched** | memory is the only copy in context |

When a tool result *is* compressed, the replacement carries a marker such as
`[density #density-1a2b3c4d · 原文 4210B · 用 density_recall(marker) 取回]`, and the full
original is archived under `~/.density/archive/<session>/`. The model can pull it back with
the lazily-registered `density_recall` tool (only registered after the first compression, so
idle sessions pay no schema cost).

## Install

From this repository:

```bash
git clone https://github.com/SpiritronPersonality/dsh-density-panel.git
# then link it into your DSH profile, e.g. in <profile>/package.json:
#   "@local/density-panel": "link:<path>/dsh-density-panel"
# and add "@local/density-panel" to dsh.profile.bundles
```

Or configure it as a bundle:

The plugin is a normal DSH client plugin bundle:

```yaml
# profile cordis patch (or the plugin's own cordis.patch.yml)
- insert:
    - id: density-panel
      name: '@local/density-panel'   # or your published package name
      config:
        mode: balanced
        write: true
        policy: quality
        surface: false
```

Restart DSH after changing config or code — the host snapshots plugin bundles at startup.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `shadow` measures only; `safe` / `balanced` enable the entry path |
| `write` | `false` | rewrite tool results (the actual compression switch) |
| `policy` | `quality` | `quality` = this document's table; `strict` = diffs only; `aggressive` = legacy sampling (tables, head/tail, code outline) |
| `surface` | `false` | extract per-turn cards and replace finished turns (off by default; changes the prefix) |
| `protectedTools` | `['cairn_']` | tool-name prefixes that are never compressed |
| `archiveDir` | `~/.density/archive` | where originals are stored |
| `ledgerDir` | `~/.density/windows` | per-window ledger |

## What you can observe

- **Panel**: sidebar entry 「密度」, Chinese UI, cards for capacity, pressure, savings,
  anchors, mirror, native compaction and the window ledger.
- **`GET /density/snapshot`**: JSON with the live window and the last 8 windows.
- **Ledger**: `~/.density/windows/<sessionId>.jsonl`, one JSON line per window snapshot.
  A window is an epoch (same provider, model, context size and trigger line). Survives restarts.
- **Metrics**: `~/.density/shadow/<sessionId>.jsonl` — every compression, recall and turn card.

## Development

```bash
# run the tests one file at a time (the node --test runner spawns children,
# which some sandboxes refuse)
for f in test/*.test.mjs; do node "$f"; done
```

Helpers:

- `tools/corpus-acceptance.mjs` — measure a corpus: ratio, hard-fact survival, detail survival.
- `tools/replay.mjs` — replay persisted DSH session logs through the entry compressor.
- `tools/repair-session-id.mjs` — repair sessions written by older versions without message ids.

## Repository layout

```
index.js          host side: events, entry compression, ledger, snapshot API
client.js         sidebar panel (Chinese UI)
lib/transform.js  pure transforms + policy gate + hard-fact gate
lib/archive.js    original-text archive + recall
lib/ledger.js     per-window ledger (JSONL)
lib/stateboard.js state board rendered into turn cards
lib/turnplan.js   turn replacement planner
tools/            corpus acceptance, replay, session repair
test/             node:test files (run one file at a time)
docs/             design and test records
```

## Publishing notes

The working copy is installed as a **profile link** (`link:D:/.../density-panel`) under the
name `@local/density-panel` with `"private": true`, which keeps accidental npm publishes
impossible. To publish under your own name:

1. rename the package in `package.json` (e.g. `dsh-density-panel`), drop `"private"`;
2. copy the name into `cordis.patch.yml` (`name:`) so the bundle id matches;
3. reinstall the bundle in your DSH profile and restart.

## Known limitations

- Compression is extractive; it cannot summarize semantics. That is why prose and code are skipped.
- Log sampling loses non-error lines; the `[统计]` line only restores aggregate counts.
- Recall costs about the size of the original — cheap only when recalls are rare.
- The UI is Chinese-only today.

## License

MIT — see [LICENSE](LICENSE).
