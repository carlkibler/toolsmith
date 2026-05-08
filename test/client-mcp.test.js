import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { MCP_BIN } from "../lib/config.js"
import { setupJsonMcpTarget } from "../lib/client-mcp.js"

const execFileAsync = promisify(execFile)

test("setupJsonMcpTarget writes a stdio toolsmith server idempotently", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-json-mcp-"))
  const configPath = path.join(home, ".opencode.json")
  const target = { label: "OpenCode", path: configPath, kind: "opencode", field: "mcp" }
  try {
    const first = setupJsonMcpTarget(target, false)
    const second = setupJsonMcpTarget(target, false)
    assert.equal(first.state, "registered")
    assert.equal(second.state, "already")
    const config = JSON.parse(await fs.readFile(configPath, "utf8"))
    assert.deepEqual(config.mcp.toolsmith.command, [process.execPath, MCP_BIN])
    assert.equal(config.mcp.toolsmith.type, "local")
    assert.equal(config.mcp.toolsmith.enabled, true)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setupJsonMcpTarget refreshes Cline config while preserving alwaysAllow", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-cline-mcp-"))
  const configPath = path.join(home, "cline_mcp_settings.json")
  const target = { label: "Cline CLI", path: configPath, kind: "cline" }
  try {
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: {
        toolsmith: {
          command: "/old/node",
          args: ["/old/toolsmith-mcp.js"],
          disabled: true,
          alwaysAllow: ["file_skeleton"],
        },
      },
    }), "utf8")
    const result = setupJsonMcpTarget(target, false)
    const config = JSON.parse(await fs.readFile(configPath, "utf8"))
    assert.equal(result.state, "refreshed")
    assert.equal(config.mcpServers.toolsmith.command, process.execPath)
    assert.deepEqual(config.mcpServers.toolsmith.args, [MCP_BIN])
    assert.equal(config.mcpServers.toolsmith.disabled, false)
    assert.deepEqual(config.mcpServers.toolsmith.alwaysAllow, ["file_skeleton"])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setupJsonMcpTarget supports VS Code and Zed MCP roots", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-vscode-zed-mcp-"))
  const vscodePath = path.join(home, "mcp.json")
  const zedPath = path.join(home, "settings.json")
  try {
    const vscode = setupJsonMcpTarget({ label: "VS Code / GitHub Copilot", path: vscodePath, kind: "vscode", field: "servers" }, false)
    const zed = setupJsonMcpTarget({ label: "Zed", path: zedPath, kind: "zed", field: "context_servers" }, false)
    const vscodeConfig = JSON.parse(await fs.readFile(vscodePath, "utf8"))
    const zedConfig = JSON.parse(await fs.readFile(zedPath, "utf8"))
    assert.equal(vscode.state, "registered")
    assert.equal(vscodeConfig.servers.toolsmith.command, process.execPath)
    assert.deepEqual(vscodeConfig.servers.toolsmith.args, [MCP_BIN])
    assert.equal(vscodeConfig.servers.toolsmith.type, "stdio")
    assert.equal(zed.state, "registered")
    assert.equal(zedConfig.context_servers.toolsmith.command, process.execPath)
    assert.deepEqual(zedConfig.context_servers.toolsmith.args, [MCP_BIN])
    assert.equal("type" in zedConfig.context_servers.toolsmith, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setupJsonMcpTarget supports command-array MCP clients", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-array-mcp-"))
  const crushPath = path.join(home, "crush.json")
  const kiloPath = path.join(home, "kilo.json")
  try {
    setupJsonMcpTarget({ label: "Crush", path: crushPath, kind: "crush", field: "mcp" }, false)
    setupJsonMcpTarget({ label: "Kilo CLI", path: kiloPath, kind: "kilo-cli", field: "mcp" }, false)
    const crush = JSON.parse(await fs.readFile(crushPath, "utf8"))
    const kilo = JSON.parse(await fs.readFile(kiloPath, "utf8"))
    assert.equal(crush.mcp.toolsmith.command, process.execPath)
    assert.deepEqual(crush.mcp.toolsmith.args, [MCP_BIN])
    assert.equal(crush.mcp.toolsmith.timeout, 120)
    assert.deepEqual(kilo.mcp.toolsmith.command, [process.execPath, MCP_BIN])
    assert.equal(kilo.mcp.toolsmith.enabled, true)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctorJsonMcpClients detects registered and drifted JSON MCP clients", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-doctor-json-mcp-"))
  try {
    await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true })
    await fs.writeFile(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
      mcp: { toolsmith: { command: [process.execPath, MCP_BIN], type: "local", enabled: true } },
    }), "utf8")
    await fs.mkdir(path.join(home, ".cursor"), { recursive: true })
    await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: { toolsmith: { command: "/old/node", args: ["/old/toolsmith-mcp.js"], type: "stdio" } },
    }), "utf8")
    const script = `import { realPathOrNull, MCP_BIN } from ${JSON.stringify(path.resolve("lib/config.js"))};
import { doctorJsonMcpClients } from ${JSON.stringify(path.resolve("lib/client-mcp.js"))};
console.log(JSON.stringify(doctorJsonMcpClients(realPathOrNull(MCP_BIN))))`
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: "/usr/bin:/bin" } })
    const byLabel = Object.fromEntries(JSON.parse(stdout).map((result) => [result.label, result]))
    assert.equal(byLabel.OpenCode.state, "ok")
    assert.equal(byLabel.Cursor.state, "drift")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
