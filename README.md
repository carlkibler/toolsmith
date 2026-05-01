# toolsmith

Portable coding-agent efficiency tools, starting with hash-anchored edit primitives inspired by Dirac's low-token editing workflow.

The first goal is a small, dependency-light core that other harnesses can wrap:

- read files with opaque stable line anchors
- apply exact, anchor-targeted edits
- batch independent edits atomically
- preserve anchors across unchanged lines after edits
- report lightweight telemetry for bytes/tokens avoided and edit payload size

Future wrappers can expose this through Pi.dev extensions, MCP servers for Claude/Codex, or other agent harnesses.

## Example

```js
import { AnchorStore, readAnchored, applyAnchoredEdits } from "toolsmith"

const store = new AnchorStore()
const read = readAnchored({ path: "src/app.js", content, store, sessionId: "task-1" })

const result = applyAnchoredEdits({
  path: "src/app.js",
  content,
  store,
  sessionId: "task-1",
  edits: [
    {
      type: "replace",
      anchor: "A1b2c3§const oldName = 1",
      endAnchor: "A1b2c3§const oldName = 1",
      text: "const newName = 1"
    }
  ]
})
```

## Licensing and attribution

Toolsmith is MIT licensed. It is inspired by Dirac and may later incorporate compatible, attribution-preserving pieces from cozempic and tokenlean. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Design Notes

See [`docs/PORTING.md`](docs/PORTING.md). Current status is in [`docs/STATUS.md`](docs/STATUS.md).

## CLI

```bash
# Read with anchors
npx toolsmith read src/app.js

# Search with compact anchored snippets
npx toolsmith search src/app.js oldName --context 2

# Read structure without full file content
npx toolsmith skeleton src/app.js
npx toolsmith get-function src/app.js oldName --context 2
npx toolsmith symbol-replace src/app.js oldName --search old --replacement new

# Apply edits from JSON
npx toolsmith edit src/app.js --edits edits.json --dry-run
```

## MCP

Run the stdio MCP server from a workspace root:

```bash
npx toolsmith-mcp
# or
npx toolsmith mcp
```

Tools:

- `anchored_read` — returns `[File Hash: ...]` and `Anchor§line` content.
- `anchored_search` — returns compact matching snippets with `Anchor§line` references.
- `file_skeleton` — returns compact anchored declaration outlines.
- `get_function` — returns one named symbol range with anchors.
- `symbol_replace` — safely replaces text inside one named symbol.
- `anchored_edit` — applies exact batched edits; stale or inexact anchors fail before writing.
- `anchored_edit_many` — validates and applies exact edits across multiple files.
- `anchored_edit_status` — smoke-test/status tool.

For Codex/Claude-style MCP config, point the command at `bin/toolsmith-mcp.mjs` or an installed `toolsmith-mcp` binary and set the working directory to the target repo.

## Pi.dev Extension

This package also includes a Pi extension at `extensions/pi-toolsmith.js` and declares it in the `pi` package manifest.

Quick local test in Pi:

```bash
pi --offline --no-builtin-tools -e ./extensions/pi-toolsmith.js --tools pi_anchored_read,pi_anchored_edit
```

Registered tools:

- `pi_anchored_read`
- `pi_anchored_search`
- `pi_file_skeleton`
- `pi_get_function`
- `pi_symbol_replace`
- `pi_anchored_edit`
- `pi_anchored_edit_many`
- `pi_anchored_status`

## Configuration

The MCP server uses the current working directory as the workspace root. Override with `TOOLSMITH_CWD`:

```json
{
  "mcpServers": {
    "toolsmith": {
      "command": "npx",
      "args": ["toolsmith-mcp"],
      "env": { "TOOLSMITH_CWD": "/path/to/your/project" }
    }
  }
}
```

## Anchor lifecycle

Anchors are valid for the **file version at read time**. Call `anchored_read` or `anchored_search` to get anchors for the current version, then use them immediately in `anchored_edit`. If another process modifies the file between your read and edit, the edit will fail with a content mismatch error — re-read and retry.

See [`AGENTS.md`](AGENTS.md) for a full guide on error recovery, `sessionId` isolation, and debugging anchor failures.

## Telemetry

Tool results include a `telemetry` object with byte counts, rough token estimates, anchor counts, edit deltas, and estimated tokens avoided versus reading the full file. Token estimates intentionally use a simple local heuristic for portable trend tracking, not billing-grade accounting.

## Verification

```bash
npm run check
npm pack --dry-run
```

Reusable harness checks are available for repeated local, Codex, and Claude validation:

```bash
./scripts/install-harnesses.sh
./scripts/test-harnesses.sh
./scripts/test-harnesses.sh --skip-local --live-codex
./scripts/test-harnesses.sh --skip-local --live-claude
```

See [`docs/TESTING.md`](docs/TESTING.md).
