# toolsmith

Save tokens in AI agent sessions — surgical reads and exact edits for Claude Code, Codex, Gemini CLI, and 15+ more agents.

Native file tools send entire files into context. Toolsmith sends only what the agent needs, with stable line anchors that make edits fail loudly instead of silently clobbering changed files.

**2.2M tokens avoided** in recent sessions. `find_and_anchor` averages ~70K tokens saved per call.

## Install

**Requires Node.js ≥ 20.**

```bash
npm install -g @carlkibler/toolsmith
toolsmith setup
toolsmith doctor --smoke
```

`setup` auto-detects every supported agent already on the machine and registers them in one shot — no manual config. `doctor --smoke` confirms the MCP handshakes work.

## Update

```bash
toolsmith update
```

Installs the latest release and re-registers all clients.

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

**Claude PreToolUse tripwire** — intercepts native `Read`/`Edit`/`Write` on large files and nudges to Toolsmith:

```bash
toolsmith setup --tripwire   # or: toolsmith adopt --tripwire
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

## Telemetry

Tool results include token estimates and tokens avoided vs a full-file read. Logged to `~/.local/state/toolsmith/usage.jsonl`. Run `toolsmith audit` to see it. Set `TOOLSMITH_USAGE_LOG=0` to disable.

## Contributing

Issues and PRs are welcome. Run `npm test` before submitting.

## License

MIT
