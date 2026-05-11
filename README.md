# toolsmith

Save tokens in AI agent sessions — surgical reads and exact edits for Claude Code, Codex, Gemini CLI, and 15+ more agents.

Native file tools send entire files into context. Toolsmith sends only what the agent needs, with anchors that make edits fail loudly instead of silently clobbering changed files.

**2.2M tokens avoided** in recent sessions. `find_and_anchor` averages ~70K tokens saved per call.

## Install

```bash
npm install -g @carlkibler/toolsmith
toolsmith setup          # registers with every detected agent on this machine
toolsmith doctor --smoke # verify the MCP handshakes
```

No config needed. Setup auto-detects and registers Claude Code, Codex, Gemini CLI, and any other supported agents already installed.

## How it works

Standard `Read` → entire file goes into context. `anchored_read` → only the section the agent asked for, with stable line anchors. `anchored_edit` → validates the anchor content is still there before writing, so stale edits fail loudly instead of silently overwriting.

```
toolsmith audit --days 7      # tokens saved vs missed, by session
toolsmith opportunities       # large-file reads with no Toolsmith call — found money
```

## MCP tools

| Tool | What it does |
|------|-------------|
| `file_skeleton` | Compact anchored outline of declarations — no bodies |
| `get_function` | One named symbol with anchors, ready to edit |
| `anchored_read` | Section read with stable anchors |
| `anchored_search` | Matching snippets with anchors, across a file or dir |
| `find_and_anchor` | Search a directory and return anchored results ready for edits |
| `symbol_replace` | Safely replace text inside one named symbol |
| `anchored_edit` | Exact batched edits; stale anchors fail before writing |
| `anchored_edit_many` | Same, across multiple files atomically |
| `anchored_edit_status` | Smoke-test tool |

## Supported agents

**MCP:** Claude Code · Codex · Gemini CLI · OpenCode · Cline · Roo Code · Kilo Code · Cursor · VS Code / Copilot · Windsurf · Continue · Zed · Qwen Code · Kimi Code · Crush · Kilo CLI

**Extension:** Pi.dev

One `toolsmith setup` registers all agents detected on the machine. `toolsmith setup --force` re-registers after an update.

## Try it now without installing

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

## Update

```bash
toolsmith update   # installs latest release and re-registers all clients
```

## Node.js library

```js
import { AnchorStore, readAnchored, applyAnchoredEdits } from "@carlkibler/toolsmith"

const store = new AnchorStore()
const read = readAnchored({ path: "src/app.js", content, store, sessionId: "task-1" })

const firstLine = read.text.split("\n").find((line) => line.includes("§"))
const result = applyAnchoredEdits({
  path: "src/app.js",
  content,
  store,
  sessionId: "task-1",
  edits: [{ type: "replace", anchor: firstLine, endAnchor: firstLine, text: "const newName = 1" }]
})
```

## Telemetry

Tool results include byte counts, token estimates, and tokens avoided vs a full-file read. Logged to `~/.local/state/toolsmith/usage.jsonl`. Run `toolsmith audit` to see it. Set `TOOLSMITH_USAGE_LOG=0` to disable, or `TOOLSMITH_USAGE_LOG=/path` to redirect.

## License

MIT
