import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { AnchorStore } from "../src/anchors.js"

export function makeStore() {
  return new AnchorStore()
}

export async function tempWorkspace(prefix = "toolsmith-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export class McpTestClient {
  constructor(proc) {
    this._proc = proc
    this._pending = new Map()
    this._nextId = 1
    this._rl = createInterface({ input: proc.stdout })
    this._rl.on("line", (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id)
        this._pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }

  static async start(serverPath, cwd, env = {}) {
    const proc = spawn(process.execPath, [serverPath], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })
    const client = new McpTestClient(proc)
    await client._send("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} })
    client._notify("notifications/initialized")
    return client
  }

  _send(method, params) {
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  _notify(method, params = {}) {
    this._proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
  }

  listTools() { return this._send("tools/list", {}) }
  callTool(name, args) { return this._send("tools/call", { name, arguments: args }) }

  close() {
    this._rl.close()
    this._proc.stdin.end()
    return new Promise((resolve) => this._proc.on("close", resolve))
  }
}
