# toolsmith

Hash-anchored file edit primitives for coding agents — validates anchor content before writing, preventing silent overwrites when files change between read and edit.

Reads return stable opaque line anchors. Edits validate anchor + line content before mutating — if the file has drifted, the edit fails loudly instead of silently clobbering. Multiple independent edits apply atomically. Works as an MCP server (Claude Code, Codex, Gemini, OpenCode, Cline, Cursor, VS Code/Copilot, Windsurf, Roo Code, Kilo Code, Continue, Zed, Qwen Code, Kimi Code, Crush), a Pi.dev extension, or a plain Node.js library.

```
toolsmith opportunities   # ~$65/week in context savings left on the table on this machine
toolsmith audit           # saved vs missed side-by-side
toolsmith doctor          # registration, drift, adoption-gap, log health
```

## Installation

```bash
npm install -g github:carlkibler/toolsmith
toolsmith install        # alias for setup; registers MCP clients and installs the Pi.dev extension when present
toolsmith doc --smoke    # alias for doctor; verify the MCP server handshakes
```

To pin a specific release:

```bash
npm install -g github:carlkibler/toolsmith#v0.1.10
```

`toolsmith update` always installs the latest GitHub release package and then refreshes client integrations by default, because MCP configs and Pi package entries store local Node/package paths. Use `toolsmith update --from /path/to/checkout` only when you intentionally want a local checkout install; otherwise update ignores whatever checkout happened to run the command. Use `--no-setup` only when you intentionally want to skip client refresh. Setup/update also installs an idempotent Codex Stop footer; it is quiet by default and prints recent Toolsmith token savings only when `TOOLSMITH_CODEX_FOOTER=1`, `TOOLSMITH_VERBOSE=1`, or `TOOLSMITH_DEBUG=1` is set. It writes only `~/.codex/hooks/toolsmith-token-footer.sh` plus one de-duplicated leading `Stop` hook entry and preserves other hooks. Use `--no-codex-footer` to skip it. Works on any machine — uses the local node binary path, so NVM and system Node both work without extra config.

To install without global:

```bash
npm install github:carlkibler/toolsmith
```

## Example

```js
import { AnchorStore, readAnchored, applyAnchoredEdits } from "@carlkibler/toolsmith"

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
toolsmith read src/app.js

# Search a file with compact anchored snippets
toolsmith search src/app.js oldName --context 2

# Search a directory and get anchors ready for editing
toolsmith find-and-anchor src oldName --glob '*.js' --context 2

# Read structure without full file content
toolsmith skeleton src/app.js
toolsmith get-function src/app.js oldName --context 2
toolsmith symbol-replace src/app.js oldName --search old --replacement new

# Apply edits from JSON
toolsmith edit src/app.js --edits edits.json --dry-run

# Prove the token-savings shape on a disposable large file
toolsmith charm

# Audit real agent adoption and large-file lost opportunities
toolsmith audit --days 7
toolsmith audit --week       # week-over-week delta + biggest missed op
toolsmith scan-agent-logs --days 7
toolsmith opportunities --days 7

# Install the optional native-use tripwire for Claude Code
# (nudges Read/Edit/Write/Bash on >200-line files toward Toolsmith)
toolsmith tripwire install --client claude
toolsmith tripwire status

# Emit instruction snippets for client configs/skills
toolsmith adoption-snippet --client codex
toolsmith tripwire snippet --client codex

# Register/refresh all known local MCP clients
# (Claude, Codex, Gemini, OpenCode, Cline/Roo/Kilo extensions, Cursor,
#  VS Code/Copilot, Windsurf, Continue, Zed, Qwen, Kimi, Crush, Kilo CLI, Pi.dev)
toolsmith setup --force
```

## MCP

Run the stdio MCP server from a workspace root:

```bash
# after global install:
toolsmith-mcp
# or without installing globally:
npx -y --package=@carlkibler/toolsmith toolsmith-mcp
```

Tools:

- `anchored_read` — returns `[File Hash: ...]` and `Anchor§line` content.
- `anchored_search` — returns compact matching snippets with `Anchor§line` references.
- `find_and_anchor` — searches a file or directory and returns anchored snippets ready for edits.
- `file_skeleton` — returns compact anchored declaration outlines.
- `get_function` — returns one named symbol range with anchors.
- `symbol_replace` — safely replaces text inside one named symbol.
- `anchored_edit` — applies exact batched edits; stale or inexact anchors fail before writing.
- `anchored_edit_many` — validates and applies exact edits across multiple files.
- `anchored_edit_status` — smoke-test/status tool.

All read-style tools tag their output with `[Workspace: <basename>]` when the MCP server is rooted at a named directory, so workspace identity travels through the agent's transcript. `anchored_edit` and `anchored_edit_many` accept an optional `workspace` field — if it disagrees with the server's workspace key, a `warnings` array is returned and a warning line is appended to the human-readable response. In 0.1.x the edit still applies; 0.2.x will reject mismatched-workspace edits outright.

For Codex/Claude-style MCP config, point the command at `bin/toolsmith-mcp.js` or an installed `toolsmith-mcp` binary and set the working directory to the target repo.

## Pi.dev Extension

This package also includes a Pi extension at `extensions/pi-toolsmith.js` and declares it in the `pi` package manifest.

Install or refresh the Pi package:

```bash
toolsmith setup --force
```

Run Pi in Toolsmith-strict mode:

```bash
toolsmith pi --print "Use Toolsmith to inspect package.json"
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
      "args": ["-y", "--package=@carlkibler/toolsmith", "toolsmith-mcp"],
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

## Effectiveness audit

The MCP server records privacy-light usage events to `~/.local/state/toolsmith/usage.jsonl` by default. Use `TOOLSMITH_USAGE_LOG=/path/to/file.jsonl` to redirect, or `TOOLSMITH_USAGE_LOG=0` to disable. Full workspace paths are omitted unless `TOOLSMITH_USAGE_FULL_PATHS=1` is set. Run `toolsmith audit --days 2` after normal Claude Code, Codex, or Gemini MCP use to verify which clients actually called toolsmith, which tools they used, edit/change counts, errors, estimated tokens avoided, and session-log lost opportunities.

`toolsmith scan-agent-logs --days 7` scans local Claude/Codex JSONL transcripts for Toolsmith adoption, interaction themes, and large-file lost opportunities. `--remote HOST` runs the same scan over SSH after that host has the current Toolsmith installed. `toolsmith opportunities` prints the compact action list, and `toolsmith adoption-snippet` prints prompt/config text for client instructions.

`toolsmith tripwire install --client claude` adds an optional Claude Code PreToolUse hook. It does not block work; it allows the tool call while returning a concise reminder when native Read/Edit/Write/MultiEdit/Bash targets a likely >200-line file. Fires are logged to `~/.local/state/toolsmith/tripwire.jsonl` so `toolsmith tripwire status` can prove whether the nudge is active. Codex setup/update uses a quieter Stop-footer hook instead of context injection: by default it does nothing visible, but with `TOOLSMITH_CODEX_FOOTER=1` it shows "Toolsmith saved ..." beside Codex's token usage without modifying prompts or existing user hooks. Use `toolsmith tripwire snippet --client codex` for Codex guidance, where MCP activation stays prompt/tool-search based rather than hook-based.

## Doctor and repair

`toolsmith doctor` checks local provenance, runtime, client registrations, Pi.dev install state, and recent usage/efficiency telemetry. `toolsmith doc` is a short alias. Useful flags:

- `--smoke` starts the MCP server, performs an initialize/list-tools handshake, and verifies expected tools exist.
- `--online` checks `origin/main` freshness and the latest published npm version.
- `--live-agent` runs disposable Codex/Gemini/Pi live checks for installed clients and verifies actual tool calls.
- `--fix` rewrites Claude/Codex/Gemini registrations, installs/refreshes Pi.dev, and refreshes the global install from the current checkout when possible.

Doctor reports whether the running CLI/MCP server points at the canonical `github.com/carlkibler/toolsmith` repo or a different checkout/fork.

The usage section includes recent startup/client counts, tool-call counts, edit/change counts, estimated tokens avoided, and suggested follow-up commands such as `toolsmith audit --days 7`.

If a client starts the MCP server but never calls any Toolsmith tools, doctor flags it as “registered but ignored” and suggests prompt/instruction nudges.

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
./scripts/test-harnesses.sh --skip-local --live-gemini
./scripts/test-harnesses.sh --skip-local --live-pi
```

See [`docs/TESTING.md`](docs/TESTING.md).
