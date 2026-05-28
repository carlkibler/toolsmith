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
| Codex session footer | `~/.codex/config.toml` hook | on, inert unless `TOOLSMITH_CODEX_FOOTER=1` | `toolsmith setup --no-codex-footer` |
| PreToolUse tripwire | `~/.claude/settings.json` | off (`--tripwire`) | `toolsmith adopt --tripwire --remove` |

Skip pieces: `toolsmith setup --no-priming --no-codex-footer`.

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

**Claude PreToolUse tripwire** — intercepts native `Read`/`Edit`/`Write` on large files and steers the agent to Toolsmith. Three escalation levels:

```bash
toolsmith tripwire install                 # allow (default): nudge, don't block
toolsmith tripwire install --mode ask      # prompt before each native large-file op
toolsmith tripwire install --mode deny     # block native large-file ops, force Toolsmith
```

`allow` just reminds. `ask`/`deny` push adoption harder — use `deny` when you want the agent to *always* go through Toolsmith on big files. Override per-session with `TOOLSMITH_TRIPWIRE_MODE=deny`. The hook always fails open: if anything goes wrong it allows the operation, never blocks you by accident.

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
