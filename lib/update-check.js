import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Dependency-free, never-blocking "update available" notifier.
//
// The CLI/MCP/tripwire read a daily-cached result instantly (no network on the hot path)
// and, at most once per day, spawn a detached background process to refresh the cache from
// the npm registry. The notice is therefore always one run behind the real check — the same
// trade npm's own update-notifier makes, and the reason it never slows anything down.
//
// We NOTIFY, never auto-apply: `toolsmith update` re-runs setup --force, which rewrites MCP
// entries and the user's CLAUDE.md across many clients and is non-atomic. Silent self-update
// of a tool with that blast radius is a footgun; a one-line nudge is not.

const PKG = "@carlkibler/toolsmith"
const DAY_MS = 86_400_000
const CLI_BIN = fileURLToPath(new URL("../bin/toolsmith.js", import.meta.url))

function stateDir() {
  return process.env.TOOLSMITH_STATE_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "toolsmith")
}

function cacheFile() {
  return path.join(stateDir(), "update-check.json")
}

export function updateCheckDisabled() {
  return Boolean(process.env.CI || process.env.TOOLSMITH_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER)
}

// Compare dotted numeric versions; ignores any pre-release suffix. Returns -1, 0, or 1.
export function compareSemver(a, b) {
  const parse = (v) => String(v).replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function readUpdateCache() {
  try { return JSON.parse(readFileSync(cacheFile(), "utf8")) } catch { return null }
}

export function writeUpdateCache(data) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(cacheFile(), JSON.stringify(data))
  } catch { /* cache is best-effort */ }
}

// Instant, cache-only. Returns { behind, current, latest } or null when latest is unknown.
export function cachedUpdateStatus(currentVersion) {
  const cache = readUpdateCache()
  if (!cache || !cache.latest || !currentVersion) return null
  let behind = false
  try { behind = compareSemver(currentVersion, cache.latest) < 0 } catch { behind = false }
  return { behind, current: currentVersion, latest: cache.latest }
}

// Is this copy of toolsmith running from a Homebrew install? Cheap path check only —
// brew installs land under HOMEBREW_PREFIX (…/Cellar/toolsmith/… or …/linuxbrew/…).
function selfUnderHomebrew() {
  const self = fileURLToPath(import.meta.url)
  const prefix = process.env.HOMEBREW_PREFIX
  if (prefix && self.startsWith(prefix)) return true
  return /[/\\](Cellar|homebrew|linuxbrew)[/\\]/i.test(self)
}

// The right update command for HOW this copy was installed — so we never tell a brew
// user to run `toolsmith update` (which shells out to npm and would shadow the brew copy).
export function updateCommand(kind) {
  if (selfUnderHomebrew()) return "brew upgrade carlkibler/tap/toolsmith"
  if (kind && String(kind).startsWith("git")) return "git pull"
  return "toolsmith update"
}

// One-line human notice, install-channel aware, or null when up to date / unknown.
export function updateNoticeText(currentVersion, { kind } = {}) {
  const status = cachedUpdateStatus(currentVersion)
  if (!status || !status.behind) return null
  return `Toolsmith ${status.current} → ${status.latest} available. Run: ${updateCommand(kind)}`
}

// Short suffix for the tripwire nudge (an outdated toolsmith is a likely cause of misuse).
export function updateNoticeSuffix(currentVersion) {
  const status = cachedUpdateStatus(currentVersion)
  if (!status || !status.behind) return ""
  return ` · toolsmith ${status.current}→${status.latest} available (run: ${updateCommand()})`
}

// Fire-and-forget: at most once/day, spawn a detached refresh. Never blocks, never throws.
// Returns true if a refresh was spawned. nowMs is injectable for tests.
export function maybeScheduleRefresh(nowMs = Date.now()) {
  if (updateCheckDisabled()) return false
  const cache = readUpdateCache()
  const last = cache && Number(cache.checkedAt) ? Number(cache.checkedAt) : 0
  if (nowMs - last < DAY_MS) return false
  // Stamp checkedAt up front so rapid repeat invocations don't each spawn a refresh.
  writeUpdateCache({ ...(cache || {}), checkedAt: nowMs })
  try {
    const child = spawn(process.execPath, [CLI_BIN, "_update-refresh"], { stdio: "ignore", detached: true })
    child.unref()
    return true
  } catch {
    return false
  }
}

// The detached worker: fetch latest from npm and write the cache. Offline/CI-safe via
// TOOLSMITH_FAKE_NPM_LATEST. Never throws.
export async function runUpdateRefresh() {
  if (updateCheckDisabled() && !process.env.TOOLSMITH_FAKE_NPM_LATEST) return
  let latest = null
  if (process.env.TOOLSMITH_FAKE_NPM_LATEST) {
    latest = process.env.TOOLSMITH_FAKE_NPM_LATEST
  } else {
    try {
      const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const json = await res.json()
        latest = typeof json.version === "string" ? json.version : null
      }
    } catch {
      latest = null
    }
  }
  if (!latest) return
  writeUpdateCache({ ...(readUpdateCache() || {}), latest, checkedAt: Date.now() })
}
