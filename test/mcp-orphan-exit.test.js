import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const MCP_BIN = path.resolve("bin/toolsmith-mcp.js")

function spawnMcp(env = {}) {
  return spawn(process.execPath, [MCP_BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TOOLSMITH_USAGE_LOG: "0", ...env },
  })
}

function initialize(child) {
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } },
  }) + "\n")
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout: initialize")), 5000)
    child.stdout.setEncoding("utf8")
    child.stdout.once("data", () => { clearTimeout(timer); resolve() })
  })
}

function exitWithin(child, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForExit(pid, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && alive(pid)) await new Promise((r) => setTimeout(r, 50))
  return !alive(pid)
}

test("MCP server: exits when the client closes stdin", async () => {
  const child = spawnMcp()
  try {
    await initialize(child)
    child.stdin.end()
    assert.ok(await exitWithin(child, 5000), "server must exit after stdin closes, not linger")
  } finally {
    if (!child.killed) child.kill("SIGKILL")
  }
})

test("MCP server: exits instead of spinning when its output pipe is broken", async () => {
  // The real zombie: the client's read end is gone, so every stdout write raises
  // EPIPE. A catch-all uncaughtException handler turns that into a 100% CPU loop.
  const child = spawnMcp()
  try {
    await initialize(child)
    child.stdout.destroy()
    child.stderr.destroy()
    // Keep asking for output it can no longer deliver.
    for (let i = 0; i < 5; i++) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "ping", params: {} }) + "\n")
    }
    assert.ok(await exitWithin(child, 5000), "server must exit on a dead output pipe, not spin on EPIPE")
  } finally {
    if (!child.killed) child.kill("SIGKILL")
  }
})

test("MCP server: exits when orphaned even though stdin stays open", async () => {
  // A parent that dies without closing the pipe leaves the server reparented to
  // PID 1 with a live-but-dead stdin. Here a FIFO held open by this test stands
  // in for that never-closing write end, so only a ppid check can save it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolsmith-orphan-"))
  const fifo = path.join(dir, "stdin.fifo")
  spawn("mkfifo", [fifo]).unref()
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(fs.existsSync(fifo), "test setup: FIFO must exist")

  // Hold the write end open for the whole test so the server never sees EOF.
  const writeFd = fs.openSync(fifo, fs.constants.O_RDWR)

  const holder = spawn(process.execPath, ["-e", `
    const fs = require("node:fs")
    const { spawn } = require("node:child_process")
    const readFd = fs.openSync(process.argv[3], "r")
    const child = spawn(process.argv[1], [process.argv[2]], {
      stdio: [readFd, "ignore", "ignore"],
      detached: true,
      env: { ...process.env, TOOLSMITH_USAGE_LOG: "0", TOOLSMITH_ORPHAN_CHECK_MS: "200" },
    })
    child.unref()
    process.stdout.write(String(child.pid))
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 500)
  `, process.execPath, MCP_BIN, fifo], { stdio: ["ignore", "pipe", "inherit"] })

  const orphanPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout: no pid from holder")), 5000)
    holder.stdout.setEncoding("utf8")
    holder.stdout.once("data", (d) => { clearTimeout(timer); resolve(Number(d.trim())) })
  })
  assert.ok(orphanPid > 0, "holder must report the spawned server pid")

  try {
    const exited = await waitForExit(orphanPid, 10000)
    assert.equal(exited, true, "orphaned server must exit instead of spinning forever")
  } finally {
    if (alive(orphanPid)) { try { process.kill(orphanPid, "SIGKILL") } catch { /* already gone */ } }
    fs.closeSync(writeFd)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
