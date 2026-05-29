# toolsmith

Save tokens in AI agent sessions — surgical reads and exact edits for Claude Code, Codex, Gemini CLI, and 15+ more agents.

Native file tools send entire files into context. Toolsmith sends only what the agent needs, with stable line anchors that make edits fail loudly instead of silently clobbering changed files.

**88–93% token reduction per call** — measured across 1,500+ real agent sessions over 30 days (Codex, Claude Code, Gemini CLI, Pi.dev). When agents use toolsmith tools instead of native reads, they send 88–93% fewer tokens for that operation. `find_and_anchor` averages ~70K tokens saved per call.

The honest catch: agents have native-tool muscle memory and don't always reach for Toolsmith on their own — across real sessions it's used on roughly a third to a half of large-file operations. That gap is the lever, and Toolsmith ships the tools to close it: a preference hint injected into your agent config, and an opt-in tripwire that nudges (or, in `--mode deny`, blocks) native large-file reads. Run `toolsmith audit` for your own numbers and `toolsmith opportunities` to see exactly what slipped through.

## Install

**Requires Node.js ≥ 20.** macOS and Linux.

**Homebrew** (macOS + Linux):

```bash
brew install carlkibler/tap/toolsmith
toolsmith setup
```

**npm**:

```bash
npm install -g @carlkibler/toolsmith
toolsmith setup
toolsmith doctor --smoke
```

`setup` auto-detects every supported agent already on the machine and registers them in one shot — no manual config. `doctor --smoke` confirms the MCP handshakes work. See [What `setup` changes](#what-setup-changes-on-your-machine) for the exact footprint.

## Quickstart — see your savings in 4 steps

```bash
brew install carlkibler/tap/toolsmith && toolsmith setup   # 1. install + register
# 2. use your agent normally for a day (let it touch some large files)
toolsmith audit --days 7      # 3. tokens saved vs missed, per session
toolsmith trends              # 4. week-over-week savings + your interception rate
```

Interception rate low? `toolsmith opportunities` shows exactly which native reads could have been Toolsmith calls — then `toolsmith setup --tripwire` nudges them automatically. That `audit → opportunities → tripwire → re-audit` loop is the whole point: Toolsmith measures its own adoption.

## Update

```bash
toolsmith update                          # npm: latest release + re-register all clients
brew upgrade carlkibler/tap/toolsmith     # Homebrew
toolsmith update --check                  # just compare current vs latest
```

Toolsmith also prints a one-line nudge (on an interactive terminal) when a newer version is available — checked at most once a day, cached, never blocking. Opt out with `TOOLSMITH_NO_UPDATE_CHECK=1`.

## What `setup` changes on your machine

Toolsmith edits config, so here's exactly what it touches. Everything is idempotent and reversible.

| What | Where | Default | Undo |
|------|-------|---------|------|
| MCP server registration | Per detected client: `claude mcp add`, `~/.codex/config.toml`, `~/.gemini`, `~/.cursor/mcp.json`, and others — only clients you have | on | re-run `setup`; or remove the MCP entry per client |
| Preference hint block | `~/.claude/CLAUDE.md`, plus `~/.codex/AGENTS.md` / `~/.gemini/GEMINI.md` / `~/AGENTS.md` if present (HTML-comment fenced) | on | `toolsmith adopt --remove` |
| Re-prime SessionStart hook | `~/.claude/settings.json` — re-asserts the rule at session start + after compaction | on (with priming); `--no-priming` skips | `toolsmith tripwire remove` |
| Codex session footer | `~/.codex/config.toml` hook | on, inert unless `TOOLSMITH_CODEX_FOOTER=1` | `toolsmith setup --no-codex-footer` |
| PreToolUse tripwire | `~/.claude/settings.json` | **on (adaptive)** — `--no-tripwire` to skip, `--tripwire-mode` to fix | `toolsmith tripwire remove` |

Skip pieces: `toolsmith setup --no-priming --no-codex-footer`. Before editing a config file, setup writes a recoverable copy next to it (`<file>.toolsmith-bak`) — `mv` it back to undo.

## MCP tools

| Tool | When to use |
|------|-------------|
| `file_skeleton` | Explore an unfamiliar file's shape — returns only declarations at ~10% token cost |
| `get_function` | Read one named symbol, ready to edit — no full-file read needed |
| `anchored_read` | Read a specific range with stable line anchors |
| `anchored_search` | Find matching lines with anchors, across a file or directory |
| `find_and_anchor` | Search a directory and get anchored results — use instead of `rg` + `sed` |
| `symbol_replace` | Edit text inside one named function or class — no pre-read required |
| `anchored_edit` | Exact batched edits; validates anchors before writing, fails loudly if stale |
| `anchored_edit_many` | Same as `anchored_edit`, across multiple files atomically |
| `anchored_edit_status` | Show active anchor sessions and registered files |

## How it works

Standard `Read` sends the entire file into context. `anchored_read` sends only the requested range, with stable opaque anchors on every line (`Aabc123§const x = 1`). `anchored_edit` validates those anchors still match before writing — stale edits fail immediately instead of silently overwriting.

```
toolsmith audit --days 7      # tokens saved vs missed, by session
toolsmith opportunities       # large-file reads with no Toolsmith follow-up
```

## Supported agents

**MCP:** Claude Code · Codex · Gemini CLI · OpenCode · Cline · Roo Code · Kilo Code · Cursor · VS Code / Copilot · Windsurf · Continue · Zed · Qwen Code · Kimi Code · Crush · Kilo CLI

**Extension:** Pi.dev

One `toolsmith setup` registers all agents detected on the machine. `toolsmith setup --force` re-registers after an update.

## Try without a global install

Run the MCP server directly:

```bash
npx -y --package=@carlkibler/toolsmith toolsmith-mcp
```

Or add to any MCP config manually:

```json
{
  "mcpServers": {
    "toolsmith": {
      "command": "npx",
      "args": ["-y", "--package=@carlkibler/toolsmith", "toolsmith-mcp"]
    }
  }
}
```

## Opt-in extras

**Codex Stop footer** — prints token savings and large-file miss counts at the end of each Codex session:

```bash
toolsmith setup                           # installs footer (opt-in via env)
TOOLSMITH_CODEX_FOOTER=1 codex "..."     # enable for a session
```

## The tripwire (adaptive, on by default)

`setup` installs a Claude `PreToolUse` hook that watches native `Read`/`Edit`/`Write` and shell `cat`/`sed`/`nl` on large files. By default it's **adaptive**: it tracks how often an agent bypasses Toolsmith in a session and gets firmer the longer it's ignored.

```
1st–2nd bypass   → nudge  (a message with the token cost; your normal permission flow still runs)
3rd–5th bypass   → ask    (Claude prompts before the native op)
6th+ bypass      → deny   (native edit blocked; agent must use a Toolsmith tool)
```

Built-in safety rails so it never walls off legitimate work: **reads never hard-block** (they cap at `ask` — you might genuinely need a full read of a file Toolsmith can't parse, like a lockfile or minified bundle); a **Write that creates a new file never blocks** (only `Write` can create a file); the nudge **never auto-approves** the native op (your own permission prompts still run); and escalation only applies within a real session, resetting fresh each time.

Compliant agents never feel it; token-burning ones get redirected. Fix the firmness instead of escalating, or turn it off:

```bash
toolsmith setup --tripwire-mode allow   # always nudge, never block
toolsmith setup --tripwire-mode deny    # block native large-file ops from the first one
toolsmith setup --no-tripwire           # don't install the hook
toolsmith tripwire remove               # remove it later
```

Override per-session with `TOOLSMITH_TRIPWIRE_MODE=allow|ask|deny|adaptive`; tune thresholds with `TOOLSMITH_TRIPWIRE_ASK_AFTER` / `TOOLSMITH_TRIPWIRE_DENY_AFTER`. The hook always **fails open** — if anything goes wrong it allows the operation, never blocks you by accident.

## Opt-in extras

**Codex Stop footer** — prints token savings and large-file miss counts at the end of each Codex session:

```bash
toolsmith setup                           # installs footer (opt-in via env)
TOOLSMITH_CODEX_FOOTER=1 codex "..."     # enable for a session
```

## Node.js library

```js
import { AnchorStore, readAnchored, applyAnchoredEdits } from "@carlkibler/toolsmith"

const store = new AnchorStore()
const content = await fs.readFile("src/app.js", "utf8")
const read = readAnchored({ path: "src/app.js", content, store, sessionId: "task-1" })

const firstLine = read.text.split("\n").find((line) => line.includes("§"))
const result = applyAnchoredEdits({
  path: "src/app.js",
  content,
  store,
  sessionId: "task-1",
  edits: [{ type: "replace", anchor: firstLine, endAnchor: firstLine, text: "const newName = 1" }],
})
```

## Privacy

**Toolsmith sends nothing off your machine.** No accounts, no API keys, no phone-home. Usage telemetry (tokens saved per call) is written only to a local file, `~/.local/state/toolsmith/usage.jsonl`, which `toolsmith audit` reads. Disable logging with `TOOLSMITH_USAGE_LOG=0`.

The only network request Toolsmith ever makes is an optional once-a-day version check against the npm registry (the "update available" nudge). Turn it off with `TOOLSMITH_NO_UPDATE_CHECK=1`.

## Uninstall

```bash
toolsmith adopt --remove                 # remove preference blocks from CLAUDE.md / AGENTS.md
toolsmith adopt --tripwire --remove      # if you enabled the tripwire
claude mcp remove toolsmith              # per client (repeat for codex / gemini / cursor / …)
brew uninstall carlkibler/tap/toolsmith  # or: npm uninstall -g @carlkibler/toolsmith
rm -rf ~/.local/state/toolsmith          # clear usage logs + update cache
```

## Contributing

Issues and PRs are welcome. Run `npm test` before submitting.

## License

MIT
