import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// Adaptive escalation state. The tripwire counts how many times an agent has bypassed Toolsmith
// with a native large-file op IN THE CURRENT SESSION, WITHOUT using a Toolsmith tool in between
// (any Toolsmith call resets the count — see resetSession). In adaptive mode, repeated edit/write
// bypasses get firmer: nudge → ask. Reads and shell inspection remain nudges because rejecting
// them tends to add retry turns without much safety. Adaptive never auto-denies — hard blocking
// is opt-in via a fixed --tripwire-mode deny. Per-session so a fresh session always starts gentle.

const ASK_AFTER = clampInt(process.env.TOOLSMITH_TRIPWIRE_ASK_AFTER, 3, 1, 100)
const PRUNE_MS = 3 * 86_400_000 // forget session counters after 3 days

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

function stateDir() {
  return process.env.TOOLSMITH_STATE_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "toolsmith")
}

function sessionsDir() {
  return path.join(stateDir(), "tripwire-sessions")
}

function sessionFile(sessionId) {
  const safe = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "default"
  return path.join(sessionsDir(), `${safe}.json`)
}

// Map a cumulative fire count to the firmness for THIS fire. Caps at "ask" by design.
export function adaptiveMode(fireCount) {
  return fireCount >= ASK_AFTER ? "ask" : "allow"
}

export const escalationThresholds = { askAfter: ASK_AFTER }

// The per-session record holds two independent signals: `fires` (adaptive bypass count) and
// `onramp` (whether the first-edit on-ramp message has fired). Both readers merge so neither
// clobbers the other.
function readSession(sessionId) {
  try {
    const obj = JSON.parse(readFileSync(sessionFile(sessionId), "utf8"))
    return obj && typeof obj === "object" ? obj : {}
  } catch { return {} }
}

function writeSession(sessionId, data) {
  mkdirSync(sessionsDir(), { recursive: true })
  writeFileSync(sessionFile(sessionId), JSON.stringify(data))
}

// Reset a session's state — called whenever the agent uses a Toolsmith tool. Clears BOTH the
// bypass count (so escalation measures CONSECUTIVE ignoring, not total large-file work) and the
// on-ramp flag (so drifting back to native editing after using Toolsmith re-arms the on-ramp
// once). An agent that's actually using Toolsmith never escalates. Best-effort.
export function resetSession(sessionId) {
  try { rmSync(sessionFile(sessionId), { force: true }) } catch { /* best-effort */ }
}

// Record one bypass for a session and return the new cumulative count. Preserves the on-ramp
// flag. Best-effort and never throws — a state-write failure must not break the tripwire (which
// would block the tool).
export function recordFire(sessionId, nowMs = Date.now()) {
  try {
    const state = readSession(sessionId)
    const fires = (Number(state.fires) || 0) + 1
    writeSession(sessionId, { ...state, fires, ts: nowMs })
    return fires
  } catch {
    return 1
  }
}

// One-time-per-session arm for the first native large-file EDIT/WRITE: returns true the FIRST
// time it's called for a session and false after, so the tripwire can emit a distinct, louder
// "first edit" on-ramp message once instead of the same nudge that gets tuned out. Independent of
// recordFire's count; cleared by resetSession. Best-effort — on a state failure it returns false
// so a broken write can never spam the on-ramp on every edit.
export function markEditOnramp(sessionId, nowMs = Date.now()) {
  try {
    const state = readSession(sessionId)
    if (state.onramp) return false
    writeSession(sessionId, { ...state, onramp: true, ts: nowMs })
    return true
  } catch {
    return false
  }
}

// Wire-vouch cache: the tripwire only recommends Toolsmith after proving, end to end, that
// the MCP server delivers anchored content (see wireCanary in config.js). The proof is a
// per-host, per-install-version fact, so it is cached globally rather than per session: a
// pass holds for a day, a failure retries within the hour so a fixed install recovers fast.
// A version change always invalidates the cache — upgrades re-verify before vouching.

const VOUCH_OK_MS = 24 * 3600_000
const VOUCH_FAIL_MS = 3600_000

function vouchFile() {
  return path.join(stateDir(), "wire-vouch.json")
}

// Returns { ok, detail } when a valid cached verdict exists for this version, else null.
export function readWireVouch(version, nowMs = Date.now()) {
  try {
    const state = JSON.parse(readFileSync(vouchFile(), "utf8"))
    if (!state || state.version !== version) return null
    const ttl = state.ok ? VOUCH_OK_MS : VOUCH_FAIL_MS
    if (nowMs - (Number(state.ts) || 0) > ttl) return null
    return { ok: Boolean(state.ok), detail: state.detail || "" }
  } catch { return null }
}

// Best-effort — a cache-write failure only means the canary reruns next fire.
export function recordWireVouch(version, ok, detail = "", nowMs = Date.now()) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(vouchFile(), JSON.stringify({ version, ok: Boolean(ok), detail: String(detail).slice(0, 300), ts: nowMs }))
  } catch { /* best-effort */ }
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
