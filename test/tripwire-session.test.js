import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { adaptiveMode, escalationThresholds, recordFire, resetSession, pruneOldSessions, markEditOnramp } from "../lib/tripwire-session.js"

async function withState(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-tw-"))
  const prev = process.env.TOOLSMITH_STATE_DIR
  process.env.TOOLSMITH_STATE_DIR = dir
  try { return await fn(dir) } finally {
    if (prev === undefined) delete process.env.TOOLSMITH_STATE_DIR
    else process.env.TOOLSMITH_STATE_DIR = prev
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test("adaptiveMode escalates allow → ask and caps there (never auto-denies)", () => {
  const { askAfter } = escalationThresholds
  assert.equal(adaptiveMode(1), "allow")
  assert.equal(adaptiveMode(askAfter - 1), "allow")
  assert.equal(adaptiveMode(askAfter), "ask")
  assert.equal(adaptiveMode(askAfter + 50), "ask") // never escalates past ask
})

test("resetSession clears the count — using Toolsmith resets escalation", async () => {
  await withState(() => {
    const { askAfter } = escalationThresholds
    for (let i = 0; i < askAfter; i += 1) recordFire("s")
    assert.equal(adaptiveMode(askAfter), "ask") // would be asking now
    resetSession("s")
    assert.equal(recordFire("s"), 1) // back to a fresh, gentle count
  })
})

test("recordFire increments per session and isolates sessions", async () => {
  await withState(() => {
    assert.equal(recordFire("sess-A"), 1)
    assert.equal(recordFire("sess-A"), 2)
    assert.equal(recordFire("sess-A"), 3)
    assert.equal(recordFire("sess-B"), 1) // a different session starts gentle again
  })
})

test("recordFire never throws and returns 1 when state is unwritable", () => {
  const prev = process.env.TOOLSMITH_STATE_DIR
  // Point at a path that cannot be a directory (a child of /dev/null) so mkdir/write fail.
  process.env.TOOLSMITH_STATE_DIR = "/dev/null/nope"
  try {
    assert.equal(recordFire("x"), 1)
  } finally {
    if (prev === undefined) delete process.env.TOOLSMITH_STATE_DIR
    else process.env.TOOLSMITH_STATE_DIR = prev
  }
})

test("markEditOnramp fires once per session, then stays quiet; isolates sessions", async () => {
  await withState(() => {
    assert.equal(markEditOnramp("s1"), true)  // first native edit of the session
    assert.equal(markEditOnramp("s1"), false) // already on-ramped — go quiet
    assert.equal(markEditOnramp("s2"), true)  // a different session arms its own on-ramp
  })
})

test("resetSession re-arms the on-ramp — drifting back to native after Toolsmith re-fires once", async () => {
  await withState(() => {
    assert.equal(markEditOnramp("s"), true)
    assert.equal(markEditOnramp("s"), false)
    resetSession("s") // agent used a Toolsmith tool
    assert.equal(markEditOnramp("s"), true) // next native edit on-ramps again, once
  })
})

test("recordFire and markEditOnramp coexist without clobbering each other", async () => {
  await withState(() => {
    assert.equal(recordFire("c"), 1)
    assert.equal(markEditOnramp("c"), true)  // sets onramp, preserves fires
    assert.equal(recordFire("c"), 2)         // fires keeps incrementing
    assert.equal(markEditOnramp("c"), false) // onramp survives the recordFire write
  })
})

test("markEditOnramp never throws and returns false when state is unwritable (no repeat spam)", () => {
  const prev = process.env.TOOLSMITH_STATE_DIR
  process.env.TOOLSMITH_STATE_DIR = "/dev/null/nope"
  try {
    assert.equal(markEditOnramp("x"), false)
  } finally {
    if (prev === undefined) delete process.env.TOOLSMITH_STATE_DIR
    else process.env.TOOLSMITH_STATE_DIR = prev
  }
})

test("pruneOldSessions removes stale counters but keeps recent ones", async () => {
  await withState(async (dir) => {
    recordFire("recent")
    recordFire("stale")
    const staleFile = path.join(dir, "tripwire-sessions", "stale.json")
    const old = Date.now() - 10 * 86_400_000
    await fs.utimes(staleFile, new Date(old), new Date(old))
    pruneOldSessions()
    assert.equal(existsSync(staleFile), false)
    assert.equal(existsSync(path.join(dir, "tripwire-sessions", "recent.json")), true)
  })
})
