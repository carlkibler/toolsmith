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
