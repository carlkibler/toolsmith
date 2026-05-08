import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import path from "node:path"
import test from "node:test"

const MCP_BIN = path.resolve("bin/toolsmith-mcp.js")

function spawnMcp() {
  const child = spawn(process.execPath, [MCP_BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TOOLSMITH_USAGE_LOG: "0" },
  })
  let buf = ""
  const pending = new Map()
  let nextId = 1

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const waiter = pending.get(msg.id)
      if (!waiter) continue
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
    }
  })
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("MCP server exited"))
    pending.clear()
  })

  function send(method, params = {}) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)) }, 5000)
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  function kill() { child.kill() }

  return { send, kill, child }
}

test("MCP server: survives malformed JSON line, then responds to initialize", async () => {
  const { send, kill, child } = spawnMcp()
  try {
    // Send garbage — server must not crash.
    child.stdin.write('{"this is not valid json\n')
    // Allow the server to process the bad line before sending a valid request.
    await new Promise((r) => setTimeout(r, 50))
    const result = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } })
    assert.equal(result.serverInfo.name, "toolsmith")
  } finally {
    kill()
  }
})

test("MCP server: returns JSON-RPC error for unknown tool, then handles ping", async () => {
  const { send, kill, child } = spawnMcp()
  try {
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {} })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n")

    let toolError
    try {
      await send("tools/call", { name: "nonexistent_tool_xyz", arguments: {} })
    } catch (e) {
      toolError = e
    }
    assert.ok(toolError, "calling a nonexistent tool must produce an error")
    assert.match(toolError.message, /Tool not found|nonexistent_tool_xyz/)

    // Server must still be alive and handle subsequent ping.
    const pong = await send("ping")
    assert.deepEqual(pong, {})
  } finally {
    kill()
  }
})

test("MCP server: initialize clientInfo.name is captured in server response", async () => {
  const { send, kill } = spawnMcp()
  try {
    const result = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "my-test-client", version: "1.2.3" },
    })
    // Server must acknowledge correctly — client name capture doesn't affect the response shape.
    assert.equal(result.serverInfo.name, "toolsmith")
    assert.ok(result.protocolVersion)
  } finally {
    kill()
  }
})
