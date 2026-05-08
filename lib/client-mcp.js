import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"
import { MCP_BIN, configuredMcpPath, evaluateDrift, realPathOrNull, tryCommand } from "./config.js"

const TOOLSMITH_TOOLS = [
  "anchored_read",
  "anchored_search",
  "anchored_edit",
  "anchored_edit_many",
  "file_skeleton",
  "find_and_anchor",
  "get_function",
  "symbol_replace",
]

function appUserPath(appName, ...parts) {
  return path.join(homedir(), "Library", "Application Support", appName, "User", ...parts)
}

function extensionMcpPath(appName, extensionId, filename = "cline_mcp_settings.json") {
  return appUserPath(appName, "globalStorage", extensionId.toLowerCase(), "settings", filename)
}

function xdgConfigPath(...parts) {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  return path.join(xdg, ...parts)
}

function commandAvailable(command) {
  const out = tryCommand(command, ["--version"])
  return out !== null && !out?.error
}

function execFileAsync(command, commandArgs) {
  return new Promise((resolve) => {
    execFile(command, commandArgs, { encoding: "utf8", timeout: 2000 }, (error, stdout, stderr) => {
      resolve(error ? { error, stdout: stdout || "", stderr: stderr || "" } : { stdout: stdout || "", stderr: stderr || "" })
    })
  })
}

async function commandAvailableAsync(command) {
  const out = await execFileAsync(command, ["--version"])
  return !out.error
}

function extensionInstalled(command, extensionId) {
  const out = tryCommand(command, ["--list-extensions"])
  const expected = extensionId.toLowerCase()
  return typeof out === "string" && out.split(/\r?\n/).some((line) => line.trim().toLowerCase() === expected)
}

async function extensionInstalledAsync(command, extensionId) {
  const out = await execFileAsync(command, ["--list-extensions"])
  if (out.error) return false
  const expected = extensionId.toLowerCase()
  return out.stdout.split(/\r?\n/).some((line) => line.trim().toLowerCase() === expected)
}

function readJsonConfig(configPath) {
  if (!existsSync(configPath)) return { path: configPath, data: {}, exists: false }
  try {
    return { path: configPath, data: JSON.parse(readFileSync(configPath, "utf8")), exists: true }
  } catch {
    return { path: configPath, error: "invalid JSON" }
  }
}

function writeJsonAtomic(configPath, data) {
  mkdirSync(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  renameSync(tmp, configPath)
}

function firstExisting(paths, fallback) {
  return paths.find((candidate) => existsSync(candidate)) || fallback || paths[0]
}

function opencodeConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  return firstExisting([
    path.join(xdg, "opencode", "opencode.json"),
    path.join(xdg, "opencode", "config.json"),
    path.join(xdg, "opencode", "opencode.jsonc"),
  ], path.join(xdg, "opencode", "opencode.json"))
}

function clientMcpTargetSpecs() {
  const clineCliPath = path.join(homedir(), ".cline", "data", "settings", "cline_mcp_settings.json")
  const clineCodePath = extensionMcpPath("Code", "saoudrizwan.claude-dev")
  const clineCursorPath = extensionMcpPath("Cursor", "saoudrizwan.claude-dev")
  const rooCodePath = firstExisting([
    extensionMcpPath("Code", "rooveterinaryinc.roo-cline", "mcp_settings.json"),
    extensionMcpPath("Code", "rooveterinaryinc.roo-cline"),
  ])
  const rooCursorPath = firstExisting([
    extensionMcpPath("Cursor", "rooveterinaryinc.roo-cline", "mcp_settings.json"),
    extensionMcpPath("Cursor", "rooveterinaryinc.roo-cline"),
  ])
  const kiloCodePath = extensionMcpPath("Code", "kilocode.kilo-code", "mcp_settings.json")
  const kiloCursorPath = extensionMcpPath("Cursor", "kilocode.kilo-code", "mcp_settings.json")
  const cursorPath = path.join(homedir(), ".cursor", "mcp.json")
  const vscodePath = appUserPath("Code", "mcp.json")
  const voidPath = appUserPath("Void", "mcp.json")
  const windsurfPath = path.join(homedir(), ".codeium", "windsurf", "mcp_config.json")
  const continuePath = path.join(homedir(), ".continue", "mcpServers", "toolsmith.json")
  const zedPath = xdgConfigPath("zed", "settings.json")
  const qwenPath = path.join(homedir(), ".qwen", "settings.json")
  const kimiPath = path.join(homedir(), ".kimi", "mcp.json")
  const crushPath = xdgConfigPath("crush", "crush.json")
  const kiloCliPath = xdgConfigPath("kilo", "kilo.json")
  return [
    {
      key: "opencode",
      label: "OpenCode",
      path: opencodeConfigPath(),
      kind: "opencode",
      field: "mcp",
      commands: ["opencode"],
    },
    {
      key: "cline-cli",
      label: "Cline CLI",
      path: clineCliPath,
      kind: "cline",
      commands: ["cline"],
    },
    {
      key: "cline-vscode",
      label: "Cline VS Code extension",
      path: clineCodePath,
      kind: "cline",
      extensions: [["code", "saoudrizwan.claude-dev"]],
    },
    {
      key: "vscode",
      label: "VS Code / GitHub Copilot",
      path: vscodePath,
      kind: "vscode",
      field: "servers",
      commands: ["code"],
    },
    {
      key: "cursor",
      label: "Cursor",
      path: cursorPath,
      kind: "cursor",
      commands: ["cursor"],
    },
    {
      key: "cline-cursor",
      label: "Cline Cursor extension",
      path: clineCursorPath,
      kind: "cline",
      extensions: [["cursor", "saoudrizwan.claude-dev"]],
    },
    {
      key: "windsurf",
      label: "Windsurf Cascade",
      path: windsurfPath,
      kind: "windsurf",
      commands: ["windsurf"],
    },
    {
      key: "roo-vscode",
      label: "Roo Code VS Code extension",
      path: rooCodePath,
      kind: "cline",
      extensions: [["code", "rooveterinaryinc.roo-cline"]],
    },
    {
      key: "roo-cursor",
      label: "Roo Code Cursor extension",
      path: rooCursorPath,
      kind: "cline",
      extensions: [["cursor", "rooveterinaryinc.roo-cline"]],
    },
    {
      key: "kilo-vscode",
      label: "Kilo Code VS Code extension",
      path: kiloCodePath,
      kind: "cline",
      extensions: [["code", "kilocode.kilo-code"]],
    },
    {
      key: "kilo-cursor",
      label: "Kilo Code Cursor extension",
      path: kiloCursorPath,
      kind: "cline",
      extensions: [["cursor", "kilocode.kilo-code"]],
    },
    {
      key: "continue",
      label: "Continue",
      path: continuePath,
      kind: "continue",
      commands: ["cn"],
      extensions: [["code", "continue.continue"], ["cursor", "continue.continue"]],
    },
    {
      key: "zed",
      label: "Zed",
      path: zedPath,
      kind: "zed",
      field: "context_servers",
      commands: ["zed"],
    },
    {
      key: "qwen",
      label: "Qwen Code",
      path: qwenPath,
      kind: "qwen",
      commands: ["qwen"],
    },
    {
      key: "kimi",
      label: "Kimi Code",
      path: kimiPath,
      kind: "kimi",
      commands: ["kimi"],
    },
    {
      key: "crush",
      label: "Crush",
      path: crushPath,
      kind: "crush",
      field: "mcp",
      commands: ["crush"],
    },
    {
      key: "kilo-cli",
      label: "Kilo CLI",
      path: kiloCliPath,
      kind: "kilo-cli",
      field: "mcp",
      commands: ["kilo"],
    },
    {
      key: "void",
      label: "Void",
      path: voidPath,
      kind: "void",
      commands: ["void"],
    },
  ]
}

function targetPresent(target) {
  if (existsSync(target.path)) return true
  return (target.commands || []).some(commandAvailable) || (target.extensions || []).some(([command, extensionId]) => extensionInstalled(command, extensionId))
}

async function targetPresentAsync(target) {
  if (existsSync(target.path)) return true
  const checks = [
    ...(target.commands || []).map(commandAvailableAsync),
    ...(target.extensions || []).map(([command, extensionId]) => extensionInstalledAsync(command, extensionId)),
  ]
  if (checks.length === 0) return false
  return (await Promise.all(checks)).some(Boolean)
}

export function clientMcpTargets() {
  return clientMcpTargetSpecs().map((target) => ({ ...target, present: targetPresent(target) }))
}

export async function clientMcpTargetsAsync() {
  const targets = clientMcpTargetSpecs()
  const present = await Promise.all(targets.map(targetPresentAsync))
  return targets.map((target, index) => ({ ...target, present: present[index] }))
}

export function toolsmithMcpServerConfig(kind, current = {}) {
  if (kind === "opencode") {
    return {
      ...current,
      type: "local",
      command: [process.execPath, MCP_BIN],
      enabled: true,
    }
  }
  if (kind === "kilo-cli") {
    return {
      ...current,
      type: "local",
      command: [process.execPath, MCP_BIN],
      enabled: true,
    }
  }
  const base = {
    command: process.execPath,
    args: [MCP_BIN],
  }
  if (kind === "crush") {
    return {
      ...current,
      ...base,
      type: "stdio",
      timeout: Number.isFinite(current.timeout) ? current.timeout : 120,
      disabled: false,
    }
  }
  if (kind === "zed") return { ...current, ...base }
  if (kind === "cline") {
    return {
      ...current,
      ...base,
      disabled: false,
      alwaysAllow: Array.isArray(current.alwaysAllow) ? current.alwaysAllow : [],
    }
  }
  return { ...current, ...base, type: "stdio" }
}

export function parseJsonMcpConfig(configPath) {
  const parsed = readJsonConfig(configPath)
  if (parsed.error) return parsed
  const server = parsed.data?.mcpServers?.toolsmith || parsed.data?.mcp?.toolsmith || parsed.data?.servers?.toolsmith || parsed.data?.context_servers?.toolsmith
  return server ? { path: configPath, ...server } : null
}

export function setupJsonMcpTarget(target, force = false) {
  const parsed = readJsonConfig(target.path)
  if (parsed.error) return { state: "error", label: target.label, path: target.path, error: parsed.error }
  const data = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? parsed.data : {}
  const field = target.field || "mcpServers"
  const servers = data[field] && typeof data[field] === "object" && !Array.isArray(data[field]) ? data[field] : {}
  const current = servers.toolsmith
  if (current && !force) {
    const drift = evaluateDrift(target.label, configuredMcpPath(current), realPathOrNull(MCP_BIN), current.command)
    const disabled = current.disabled === true
    if (drift.state === "ok" && !disabled) return { state: "already", label: target.label, path: target.path }
  }
  data[field] = { ...servers, toolsmith: toolsmithMcpServerConfig(target.kind, current || {}) }
  writeJsonAtomic(target.path, data)
  return { state: current ? "refreshed" : "registered", label: target.label, path: target.path }
}

export function setupJsonMcpClients(force = false) {
  return clientMcpTargets().map((target) => {
    if (!target.present) return { state: "skipped", label: target.label, path: target.path }
    return setupJsonMcpTarget(target, force)
  })
}

export async function setupJsonMcpClientsAsync(force = false) {
  const targets = await clientMcpTargetsAsync()
  return targets.map((target) => {
    if (!target.present) return { state: "skipped", label: target.label, path: target.path }
    return setupJsonMcpTarget(target, force)
  })
}

export function doctorJsonMcpClients(expectedMcpPath) {
  return clientMcpTargets().map((target) => {
    if (!target.present) return { state: "missing", label: target.label, path: target.path }
    const parsed = parseJsonMcpConfig(target.path)
    if (parsed?.error) return { state: "error", label: target.label, path: target.path, error: parsed.error }
    if (!parsed) return { state: "unregistered", label: target.label, path: target.path }
    const drift = evaluateDrift(target.label, configuredMcpPath(parsed), expectedMcpPath, parsed.command)
    if (drift.state !== "ok") return { state: "drift", label: target.label, path: target.path, message: drift.message }
    if (parsed.disabled === true) return { state: "disabled", label: target.label, path: target.path }
    return { state: "ok", label: target.label, path: target.path }
  })
}

export { TOOLSMITH_TOOLS }
