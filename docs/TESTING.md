# Testing harnesses

Reusable checks live in `scripts/` so agent-harness behavior can be re-run after Codex, Claude, Pi, or MCP updates.

## Install/update MCP registrations

```bash
./scripts/install-harnesses.sh
# or
npm run install:harnesses
```

This registers the local MCP server path with Codex and Claude as `dirac-edit-core`.

## Cheap default checks

```bash
./scripts/test-harnesses.sh
# or
npm run test:harnesses
```

Default checks do not call models. They run:

- `npm run check`
- `npm pack --dry-run`
- `codex mcp get dirac-edit-core`
- `claude mcp get dirac-edit-core`

Artifacts are written under `~/dev/agent-notes/dirac-edit-core/harness-<timestamp>/` unless `DIRAC_EDIT_CORE_ARTIFACT_DIR` is set.

## Live agent checks

Live checks create disposable temp workspaces inside the artifact directory, ask the agent to use the `dirac-edit-core` MCP tools, then validate both the final file content and the tool-call trace.

```bash
./scripts/test-harnesses.sh --skip-local --live-codex
./scripts/test-harnesses.sh --skip-local --live-claude
./scripts/test-harnesses.sh --live
# or
npm run test:harnesses:live
```

The live checks intentionally use bypass/skip-permission modes only inside disposable workspaces. This avoids interactive MCP approvals and keeps the validation re-runnable in background sessions.

## Current harness behavior covered

- Codex can discover the MCP server and call `anchored_read` + `anchored_edit` in a disposable workspace.
- Claude can discover the MCP server and call `anchored_read` + `anchored_edit` in a disposable workspace.
- The edit must use the exact returned `Anchor§line` reference plus `endAnchor` for a single-line replace.
- The target file must end as exactly:

```text
alpha
BETA
gamma
```

Codex normal approval mode may still cancel mutating MCP calls in non-interactive `exec`; the live Codex check uses `--dangerously-bypass-approvals-and-sandbox` in a disposable workspace to test the core behavior without a human approval prompt.
