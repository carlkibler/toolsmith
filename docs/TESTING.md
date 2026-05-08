# Testing harnesses

Reusable checks live in `scripts/` so agent-harness behavior can be re-run after Codex, Claude, Pi, or MCP updates.

## Install/update client integrations

```bash
./scripts/install-harnesses.sh
# or
npm run install:harnesses
```

This registers the local MCP server path with Codex, Claude, and Gemini as `toolsmith`, and runs `pi install` for the local Toolsmith package when Pi is available.

The CLI also accepts the friendly aliases `toolsmith install` for `toolsmith setup` and `toolsmith doc` for `toolsmith doctor`. `toolsmith update` refreshes MCP registrations and the Pi package by default after updating; use `--no-setup` only to skip that repair step.

## Cheap default checks

```bash
./scripts/test-harnesses.sh
# or
npm run test:harnesses
```

Default checks do not call models. They run:

- `npm run check`
- `npm pack --dry-run`
- `codex mcp get toolsmith`
- `claude mcp get toolsmith`
- `gemini mcp list` / `~/.gemini/settings.json` includes `toolsmith`
- `pi list` includes the Toolsmith package when Pi is installed

Artifacts are written under `~/dev/agent-notes/toolsmith/harness-<timestamp>/` unless `TOOLSMITH_ARTIFACT_DIR` is set. The old `DIRAC_EDIT_CORE_ARTIFACT_DIR` alias is still accepted during the rename transition.

## Live agent checks

Live checks create disposable temp workspaces inside the artifact directory, ask the agent to use the `toolsmith` MCP tools, then validate both the final file content and the tool-call trace.

```bash
./scripts/test-harnesses.sh --skip-local --live-codex
./scripts/test-harnesses.sh --skip-local --live-claude
./scripts/test-harnesses.sh --skip-local --live-gemini
./scripts/test-harnesses.sh --skip-local --live-pi
./scripts/test-harnesses.sh --live
# or
npm run test:harnesses:live
```

The live checks intentionally use bypass/skip-permission modes only inside disposable workspaces. This avoids interactive MCP approvals and keeps the validation re-runnable in background sessions.

## Current harness behavior covered

- Codex can discover the MCP server and call `file_skeleton`, `symbol_replace`, `anchored_search`, and `anchored_edit` in a disposable workspace.
- Claude can discover the MCP server and call `file_skeleton`, `symbol_replace`, `anchored_search`, and `anchored_edit` in a disposable workspace.
- Gemini can discover the MCP server and call `file_skeleton`, `symbol_replace`, `anchored_search`, and `anchored_edit` in a disposable workspace.
- Pi can run through `toolsmith pi` with built-ins disabled and call `pi_file_skeleton`, `pi_symbol_replace`, `pi_anchored_search`, and `pi_anchored_edit` in a disposable workspace.
- Toolsmith writes matching JSONL usage records for those calls, so the audit can prove real MCP usage instead of relying only on model self-report.
- The edit must use the exact returned `Anchor§line` reference plus `endAnchor` for a single-line replace.
- The target file must end as exactly:

```text
alpha
BETA
gamma
```

Codex normal approval mode may still cancel mutating MCP calls in non-interactive `exec`; the live Codex check uses `--dangerously-bypass-approvals-and-sandbox` in a disposable workspace to test the core behavior without a human approval prompt.

## Usage instrumentation

Every MCP server process writes privacy-light JSONL usage events by default to:

```text
~/.local/state/toolsmith/usage.jsonl
```

Set `TOOLSMITH_USAGE_LOG=/path/to/usage.jsonl` to redirect it, or `TOOLSMITH_USAGE_LOG=0` to disable it. Events include startup/tool-list/tool-call timestamps, inferred client (`codex`, `claude`, `gemini`, or unknown), tool name, duration, sanitized argument summaries, structured telemetry, edit/change counts, workspace hash, and token-savings estimates. Full workspace paths and parent command args are omitted by default; set `TOOLSMITH_USAGE_FULL_PATHS=1` only for disposable harness runs. Tool arguments that could contain user text (`text`, `replacement`, `search`, `query`, anchors) are recorded as byte counts plus local hashes instead of raw content.

Run a quick effectiveness audit after a day or two of normal use:

```bash
toolsmith audit --days 2
toolsmith audit --days 2 --json
```

`toolsmith audit` separates non-test agent calls from harness/test calls. This matters because `toolsmith doctor --live-agent` intentionally creates tiny disposable workspaces (`toolsmith-*`, `codex-workspace`, etc.) whose successful MCP calls prove wiring but do not prove Claude/Codex/Gemini are choosing Toolsmith during real project work.

The live harnesses now also force per-run usage logs (`codex-usage.jsonl`, `claude-usage.jsonl`) and fail if the expected MCP tool calls are not present in both the agent transcript and the toolsmith usage log.
