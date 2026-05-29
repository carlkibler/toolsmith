import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// Adaptive escalation state. The tripwire counts how many times an agent has bypassed
// Toolsmith with a native large-file op IN THE CURRENT SESSION, and gets firmer the longer
// it's ignored: nudge → ask → deny. Compliant agents never feel it; agents that keep burning
// tokens get redirected. Per-session so a fresh session always starts gentle.

const ASK_AFTER = clampInt(process.env.TOOLSMITH_TRIPWIRE_ASK_AFTER, 3, 1, 100)
// deny must never come before ask, even if a user misconfigures the thresholds.
const DENY_AFTER = Math.max(clampInt(process.env.TOOLSMITH_TRIPWIRE_DENY_AFTER, 6, 1, 1000), ASK_AFTER)
const PRUNE_MS = 3 * 86_400_000 // forget session counters after 3 days

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

function sessionsDir() {
  const base = process.env.TOOLSMITH_STATE_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "toolsmith")
  return path.join(base, "tripwire-sessions")
}

function sessionFile(sessionId) {
  const safe = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "default"
  return path.join(sessionsDir(), `${safe}.json`)
}

// Map a cumulative fire count to the firmness for THIS fire.
export function adaptiveMode(fireCount) {
  if (fireCount >= DENY_AFTER) return "deny"
  if (fireCount >= ASK_AFTER) return "ask"
  return "allow"
}

export const escalationThresholds = { askAfter: ASK_AFTER, denyAfter: DENY_AFTER }

// Record one bypass for a session and return the new cumulative count. Best-effort and
// never throws — a state-write failure must not break the tripwire (which would block the tool).
export function recordFire(sessionId, nowMs = Date.now()) {
  try {
    mkdirSync(sessionsDir(), { recursive: true })
    const file = sessionFile(sessionId)
    let fires = 0
    try { fires = Number(JSON.parse(readFileSync(file, "utf8")).fires) || 0 } catch { /* fresh */ }
    fires += 1
    writeFileSync(file, JSON.stringify({ fires, ts: nowMs }))
    return fires
  } catch {
    return 1
  }
}

// Opportunistically drop stale session counters so the dir can't grow without bound.
export function pruneOldSessions(nowMs = Date.now()) {
  try {
    for (const name of readdirSync(sessionsDir())) {
      const file = path.join(sessionsDir(), name)
      try {
        if (nowMs - statSync(file).mtimeMs > PRUNE_MS) rmSync(file, { force: true })
      } catch { /* ignore one bad entry */ }
    }
  } catch { /* dir may not exist yet */ }
}
