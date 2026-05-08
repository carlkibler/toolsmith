import { existsSync, readFileSync, realpathSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import path from "node:path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.join(__dirname, "..")
export const MCP_BIN = path.join(PACKAGE_ROOT, "bin", "toolsmith-mcp.js")

export function realPathOrNull(target) {
  if (!target) return null
  try { return realpathSync(target) } catch { return null }
}

export function tryCommand(command, commandArgs) {
  try {
    return execFileSync(command, commandArgs, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
  } catch (e) {
    if (e.code === "ENOENT") return null
    return { error: (e.stderr?.toString() || e.message || "").trim() }
  }
}

export function packageInfo() {
  const packagePath = path.join(__dirname, "..", "package.json")
  try { return JSON.parse(readFileSync(packagePath, "utf8")) } catch { return {} }
}

export function git(rootArgs, fallback = null) {
  const out = tryCommand("git", rootArgs)
  return typeof out === "string" ? out.trim() : fallback
}

export function gitRoot(root = PACKAGE_ROOT) { return git(["-C", root, "rev-parse", "--show-toplevel"]) }
export function gitRemote(root, name = "origin") { return root ? git(["-C", root, "remote", "get-url", name]) : null }
export function gitBranch(root) { return process.env.TOOLSMITH_FAKE_BRANCH ?? (root ? git(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"]) : null) }
export function gitHead(root) { return root ? git(["-C", root, "rev-parse", "--short", "HEAD"]) : null }
export function gitDirty(root) { return root ? git(["-C", root, "status", "--porcelain"], "") !== "" : false }

export function fetchAndGetAheadBehind(root) {
  if (!root) return null
  try {
    execFileSync("git", ["-C", root, "fetch", "--quiet", "origin", "main"], { stdio: "ignore", timeout: 10000 })
  } catch {
    return null
  }
  const out = git(["-C", root, "rev-list", "--left-right", "--count", "HEAD...origin/main"], "")
  const [ahead, behind] = out.split(/\s+/).map((n) => Number(n))
  if (Number.isFinite(ahead) && Number.isFinite(behind)) return { ahead, behind }
  return null
}

export function githubLatestRelease(owner, repo) {
  if (process.env.TOOLSMITH_FAKE_RELEASE_TAG) {
    return {
      tag: process.env.TOOLSMITH_FAKE_RELEASE_TAG,
      publishedAt: process.env.TOOLSMITH_FAKE_RELEASE_PUBLISHED_AT || null,
    }
  }
  const out = tryCommand("curl", ["-fsSL", `https://api.github.com/repos/${owner}/${repo}/releases/latest`])
  if (!out || typeof out !== "string") return null
  try {
    const data = JSON.parse(out)
    if (!data.tag_name) return null
    return { tag: data.tag_name, publishedAt: data.published_at || null }
  } catch {
    return null
  }
}

export function parseCodexToolsmithConfig() {
  const codexConfig = path.join(homedir(), ".codex", "config.toml")
  if (!existsSync(codexConfig)) return null
  let lines
  try {
    lines = readFileSync(codexConfig, "utf8").split(/\r?\n/)
  } catch (e) {
    return { error: e.message, path: codexConfig }
  }
  const section = []
  let inSection = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "[mcp_servers.toolsmith]") { inSection = true; continue }
    if (inSection && trimmed.startsWith("[") && trimmed.endsWith("]")) break
    if (inSection) section.push(line)
  }
  if (!section.length) return null
  const commandLine = section.find((line) => line.trim().startsWith("command ="))
  const argsLine = section.find((line) => line.trim().startsWith("args ="))
  const command = commandLine?.replace(/^\s*command\s*=\s*/, "").trim().replace(/^"|"$/g, "")
  let parsedArgs = []
  try { parsedArgs = argsLine ? JSON.parse(argsLine.replace(/^\s*args\s*=\s*/, "").trim()) : [] } catch {}
  return { path: codexConfig, command, args: parsedArgs }
}

export function parseCodexApprovalPolicy() {
  const codexConfig = path.join(homedir(), ".codex", "config.toml")
  if (!existsSync(codexConfig)) return null
  try {
    const lines = readFileSync(codexConfig, "utf8").split(/\r?\n/)
    for (const line of lines) {
      const m = line.match(/^\s*approval_policy\s*=\s*"?([^"]+)"?\s*$/)
      if (m) return m[1].trim()
    }
  } catch {}
  return null
}

export function parseGeminiToolsmithConfig() {
  const settings = path.join(homedir(), ".gemini", "settings.json")
  if (!existsSync(settings)) return null
  try {
    const data = JSON.parse(readFileSync(settings, "utf8"))
    return data?.mcpServers?.toolsmith ? { path: settings, ...data.mcpServers.toolsmith } : null
  } catch {
    return { path: settings, error: "invalid JSON" }
  }
}

export function parsePiToolsmithConfig() {
  const settings = path.join(homedir(), ".pi", "agent", "settings.json")
  if (!existsSync(settings)) return null
  try {
    const data = JSON.parse(readFileSync(settings, "utf8"))
    const packages = Array.isArray(data?.packages) ? data.packages : []
    const settingsDir = path.dirname(settings)
    const expectedRoot = realPathOrNull(PACKAGE_ROOT)
    const toolsmithSourcePattern = /(?:^|[/@:])toolsmith(?:$|[/#@:])/
    const entries = packages.map((source) => {
      const localish = !/^(?:npm:|git:|https?:|ssh:)/.test(source)
      const resolvedPath = localish ? path.resolve(settingsDir, source.replace(/^file:/, "")) : null
      const realPath = resolvedPath ? realPathOrNull(resolvedPath) : null
      const isToolsmith = source === PACKAGE_ROOT || realPath === expectedRoot || toolsmithSourcePattern.test(source)
      return { source, resolvedPath, realPath, isToolsmith }
    })
    const toolsmithEntries = entries.filter((entry) => entry.isToolsmith)
    const installedEntry = toolsmithEntries[0]
    return {
      path: settings,
      installed: installedEntry?.source,
      installedPath: installedEntry?.resolvedPath,
      installedRealPath: installedEntry?.realPath,
      toolsmithEntries,
      packages,
    }
  } catch {
    return { path: settings, error: "invalid JSON" }
  }
}

export function configuredMcpPath(config) {
  const argTarget = config?.args?.find?.((arg) => /toolsmith-mcp\.(?:js|mjs)$/.test(arg))
  const commandTarget = Array.isArray(config?.command) ? config.command.find((arg) => /toolsmith-mcp\.(?:js|mjs)$/.test(arg)) : null
  const target = argTarget || commandTarget
  return target ? realPathOrNull(target) || target : null
}

export function isCanonicalRepo(remote) {
  return /github\.com[:/]carlkibler\/toolsmith(?:\.git)?$/i.test(remote || "")
}

let _installContext = null
export function installContext() {
  if (_installContext) return _installContext
  const binRealPath = realPathOrNull(fileURLToPath(import.meta.url))
  const repoRoot = gitRoot()
  const remote = process.env.TOOLSMITH_FAKE_REMOTE ?? gitRemote(repoRoot)
  const npmPrefixOut = tryCommand("npm", ["prefix", "-g"])
  const npmGlobalPrefix = process.env.TOOLSMITH_FAKE_NPM_PREFIX || (typeof npmPrefixOut === "string" ? npmPrefixOut.trim() : null)
  const npmGlobalToolsmithPath = npmGlobalPrefix ? path.join(npmGlobalPrefix, "lib", "node_modules", "@carlkibler", "toolsmith") : null
  const npmGlobalIsLive = npmGlobalToolsmithPath ? existsSync(npmGlobalToolsmithPath) : false
  const npmGlobalToolsmithRealPath = npmGlobalIsLive ? realPathOrNull(npmGlobalToolsmithPath) : null
  let kind = "unknown"
  if (binRealPath && npmGlobalPrefix && binRealPath.startsWith(npmGlobalPrefix + path.sep)) {
    kind = "npm-global"
  } else if (repoRoot && isCanonicalRepo(remote)) {
    kind = "git-checkout-canonical"
  } else if (repoRoot) {
    kind = "git-checkout-other"
  }
  _installContext = { kind, binRealPath, repoRoot, remote, npmGlobalPrefix, npmGlobalToolsmithPath, npmGlobalToolsmithRealPath, npmGlobalIsLive }
  return _installContext
}

export function parseClaudeToolsmithGet() {
  const out = tryCommand("claude", ["mcp", "get", "toolsmith"])
  if (typeof out !== "string") return null
  const command = out.match(/^\s*Command:\s*(.+)$/m)?.[1]?.trim()
  const argsLine = out.match(/^\s*Args:\s*(.+)$/m)?.[1]?.trim()
  return { command, args: argsLine ? argsLine.split(/\s+/) : [] }
}

export function evaluateDrift(label, configuredPath, expectedMcpPath, command) {
  if (!configuredPath) return { state: "missing-config" }
  const real = realPathOrNull(configuredPath)
  if (!real) return { state: "stale", message: `${label}: registered path does not exist on disk: ${configuredPath}` }
  if (real !== expectedMcpPath) return { state: "drift", message: `${label}: registered ${real}, expected ${expectedMcpPath}` }
  const commandPath = Array.isArray(command) ? command[0] : command
  if (commandPath && !existsSync(commandPath)) return { state: "stale", message: `${label}: configured Node binary no longer exists: ${commandPath}` }
  return { state: "ok" }
}

export async function mcpSmoke(command, commandArgs) {
  const child = spawn(command, commandArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TOOLSMITH_USAGE_LOG: "0" },
  })
  let nextId = 1
  let stdout = ""
  let stderr = ""
  let spawnError = null
  const pending = new Map()

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    stdout += chunk
    let newline
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, newline).trim()
      stdout = stdout.slice(newline + 1)
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
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.on("error", (error) => {
    spawnError = error
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  })
  child.on("exit", (code, signal) => {
    const message = `MCP server exited${code === null ? "" : ` ${code}`}${signal ? ` (${signal})` : ""}${stderr.trim() ? ` — ${stderr.trim()}` : ""}`
    for (const waiter of pending.values()) waiter.reject(new Error(message))
    pending.clear()
  })

  function request(method, params = {}) {
    if (spawnError) return Promise.reject(spawnError)
    const id = nextId++
    const payload = { jsonrpc: "2.0", id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out${stderr.trim() ? ` — ${stderr.trim()}` : ""}`)) }, 5000)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  try {
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "toolsmith-doctor", version: packageInfo().version || "0.0.0" } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`)
    const list = await request("tools/list")
    return (list?.tools || []).map((tool) => tool.name).sort()
  } finally {
    child.kill()
  }
}
