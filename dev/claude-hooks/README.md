# Dev-only Claude Code hooks

These scripts are **optional development-validation hooks** for working *on Toolsmith
itself*. They are **not** part of the Toolsmith product and are **never installed by
`toolsmith setup`/`update`**, never published to npm, and must never be referenced by a
user's global Claude config.

| Hook | Event | What it does |
|------|-------|--------------|
| `baseline-guard.sh` | SessionStart | Runs the test suite once and records a pass/fail baseline in the active bead |
| `cheap-watcher.sh` | PostToolUse(Edit\|Write) | Cheap-model review of large edits, rate-limited |
| `quality-gate.sh` | Stop | Diffs the active bead's requirements against the git diff |

## Why they live here and not in `templates/`

They previously sat in `templates/.claude/hooks/`. That path *looked* like "files to
copy into `~/.claude`", but nothing installed them — so a global `settings.json` that
referenced them errored on every machine that never got a manual copy.
The lesson is the doctrine in the repo `CLAUDE.md`:

> Toolsmith must provide, update, and manage any file it expects a harness to access.
> It must never leave a dangling reference to a file it does not install.

These are heavy hooks (run tests / call models on every edit or stop). Per Toolsmith's
own "Hook Integration Judgment", they are exactly what Toolsmith must **not** auto-install.

## Using them for dev validation

If you want them while developing Toolsmith, wire them into **this repo's**
project-local `.claude/settings.json` only — never a global config — and run them from
this path. You own that wiring; Toolsmith setup will not touch it.
