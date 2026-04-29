# dirac-edit-core

Portable hash-anchored edit primitives inspired by Dirac's low-token editing workflow.

The first goal is a small, dependency-light core that other harnesses can wrap:

- read files with opaque stable line anchors
- apply exact, anchor-targeted edits
- batch independent edits atomically
- preserve anchors across unchanged lines after edits

Future wrappers can expose this through Pi.dev extensions, MCP servers for Claude/Codex, or other agent harnesses.

## Example

```js
import { AnchorStore, readAnchored, applyAnchoredEdits } from "dirac-edit-core"

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

## Design Notes

See [`docs/PORTING.md`](docs/PORTING.md).

## CLI

```bash
# Read with anchors
npx dirac-edit-core read src/app.js

# Apply edits from JSON
npx dirac-edit-core edit src/app.js --edits edits.json --dry-run
```

## MCP

Run the stdio MCP server from a workspace root:

```bash
npx dirac-edit-core-mcp
# or
npx dirac-edit-core mcp
```

Tools:

- `anchored_read` — returns `[File Hash: ...]` and `Anchor§line` content.
- `anchored_edit` — applies exact batched edits; stale or inexact anchors fail before writing.
- `anchored_edit_many` — validates and applies exact edits across multiple files.
- `anchored_edit_status` — smoke-test/status tool.

For Codex/Claude-style MCP config, point the command at `bin/dirac-edit-core-mcp.mjs` or an installed `dirac-edit-core-mcp` binary and set the working directory to the target repo.

## Pi.dev Extension

This package also includes a Pi extension at `extensions/pi-dirac-edit-core.js` and declares it in the `pi` package manifest.

Quick local test in Pi:

```bash
pi --offline --no-builtin-tools -e ./extensions/pi-dirac-edit-core.js --tools pi_anchored_read,pi_anchored_edit
```

Registered tools:

- `pi_anchored_read`
- `pi_anchored_edit`
- `pi_anchored_edit_many`
- `pi_anchored_status`

## Verification

```bash
npm run check
npm pack --dry-run
```
