import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import path from "node:path"
import { args, option } from "./argv.js"
import { tryCommand, installContext, packageInfo, git, gitBranch, gitDirty, fetchAndGetAheadBehind, githubLatestRelease, realPathOrNull, MCP_BIN, parseClaudeToolsmithGet, configuredMcpPath, evaluateDrift, parseGeminiToolsmithConfig, parseCodexToolsmithConfig, mcpSmoke } from "./config.js"
import { setupJsonMcpClientsAsync } from "./client-mcp.js"
import { setupPiResult } from "./pi.js"
import { installClaudeTripwire, removeClaudeTripwire } from "./tripwire.js"
import { installCodexFooter } from "./codex-footer.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, "..")

export const PRIMING_SENTINEL_BEGIN = "<!-- toolsmith:begin -->"
export const PRIMING_SENTINEL_END = "<!-- toolsmith:end -->"
export const PRIMING_BLOCK_CONTENT = `## Toolsmith MCP

Toolsmith is the default path for large-file code navigation and surgical edits when MCP tools are available. Use native Read/Edit/Write, shell \`cat\`, \`nl\`, or broad \`sed -n\` on files likely over 200 lines only when Toolsmith is unavailable or the file is genuinely small.

- Explore first: \`mcp__toolsmith__file_skeleton\`, \`mcp__toolsmith__get_function\`, or bounded \`mcp__toolsmith__anchored_read\`
- Search before editing: \`mcp__toolsmith__find_and_anchor\` or \`mcp__toolsmith__anchored_search\` instead of \`rg\` + \`sed\`/\`cat\`
- Edit with validation: \`mcp__toolsmith__anchored_edit\` / \`mcp__toolsmith__anchored_edit_many\`
- Single-symbol edits: \`mcp__toolsmith__symbol_replace\`
- If you already used a native large-file read, switch to Toolsmith before editing so anchors and telemetry exist
`

export function promptYN(question, autoYes) {
  if (autoYes) return true
  if (!process.stdin.isTTY) {
    process.stderr.write(`  (stdin is not a TTY — pass --yes to auto-confirm)\n`)
    return false
  }
  process.stdout.write(`  ${question} [y/N]: `)
  const buf = Buffer.alloc(64)
  let n = 0
  try { n = readSync(0, buf, 0, 64) } catch {}
  return buf.slice(0, n).toString().trim().toLowerCase().startsWith("y")
}

export function injectPrimingBlock(targetPath) {
  const block = `${PRIMING_SENTINEL_BEGIN}\n${PRIMING_BLOCK_CONTENT}\n${PRIMING_SENTINEL_END}`
  let existing = ""
  try { existing = readFileSync(targetPath, "utf8") } catch (e) { if (e.code !== "ENOENT") throw e }
  const beginIdx = existing.indexOf(PRIMING_SENTINEL_BEGIN)
  const endIdx = beginIdx !== -1 ? existing.indexOf(PRIMING_SENTINEL_END, beginIdx) : -1
  let updated
  if (beginIdx !== -1 && endIdx !== -1) {
    updated = existing.slice(0, beginIdx) + block + existing.slice(endIdx + PRIMING_SENTINEL_END.length)
  } else {
    const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n"
    updated = existing + sep + block + "\n"
  }
  if (updated === existing) return false
  mkdirSync(path.dirname(targetPath), { recursive: true })
  const tmp = targetPath + ".toolsmith-tmp"
  writeFileSync(tmp, updated, "utf8")
  try {
    renameSync(tmp, targetPath)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
  return true
}

export function removePrimingBlock(targetPath) {
  let existing = ""
  try { existing = readFileSync(targetPath, "utf8") } catch (e) {
    if (e.code !== "ENOENT") console.log(`  failed: ${targetPath} — ${e.message}`)
    return
  }
  const beginIdx = existing.indexOf(PRIMING_SENTINEL_BEGIN)
  const endIdx = beginIdx !== -1 ? existing.indexOf(PRIMING_SENTINEL_END, beginIdx) : -1
  if (beginIdx === -1 || endIdx === -1) { console.log(`  not present: ${targetPath}`); return }
  const after = endIdx + PRIMING_SENTINEL_END.length
  const trailingLen = (existing.slice(after).match(/^\n+/) || [""])[0].length
  const updated = (existing.slice(0, beginIdx) + existing.slice(after + trailingLen)).trimEnd()
  writeFileSync(targetPath, updated.length > 0 ? updated + "\n" : "", "utf8")
  console.log(`  removed: ${targetPath}`)
}

export function adoptInject() {
  const targets = [path.join(homedir(), ".claude", "CLAUDE.md")]
  if (existsSync(path.join(homedir(), ".codex"))) targets.push(path.join(homedir(), ".codex", "AGENTS.md"))
  if (existsSync(path.join(homedir(), ".gemini"))) targets.push(path.join(homedir(), ".gemini", "GEMINI.md"))
  const localAgents = path.join(process.cwd(), "AGENTS.md")
  if (existsSync(localAgents)) targets.push(localAgents)
  for (const target of targets) {
    const changed = injectPrimingBlock(target)
    console.log(changed ? `  injected: ${target}` : `  already present: ${target}`)
  }
}

export function removeTomlSection(content, header) {
  const lines = content.split(/\r?\n/)
  const out = []
  let skipping = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!skipping && trimmed === header) { skipping = true; continue }
    if (skipping && trimmed.startsWith("[") && trimmed.endsWith("]")) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join("\n").trimEnd()
}

export function hasToolsmithCodexOrphans(content) {
  return content.split(/\r?\n/).some((line) => /^\["[^"\n]*toolsmith-mcp\.(?:js|mjs)"\]\s*$/.test(line.trim()))
}

export function removeToolsmithCodexConfig(content) {
  const withoutServer = removeTomlSection(content, "[mcp_servers.toolsmith]")
  return withoutServer
    .split(/\r?\n/)
    .filter((line) => !/^\["[^"\n]*toolsmith-mcp\.(?:js|mjs)"\]\s*$/.test(line.trim()))
    .join("\n")
    .trimEnd()
}

export function tryClaude(claudeArgs) { return tryCommand("claude", claudeArgs) }
export function tryGemini(geminiArgs) { return tryCommand("gemini", geminiArgs) }

function clientResult(label, state, message, extra = {}) {
  return { label, state, messages: message ? [`  ${message}`] : [], ...extra }
}

function printClientResults(results) {
  const priority = new Map([
    ["Claude Code", 0],
    ["Codex", 1],
    ["Codex footer", 2],
    ["Pi.dev", 3],
    ["OpenCode", 4],
    ["Gemini CLI", 5],
  ])
  const printable = results
    .flat()
    .filter((result) => result && result.state !== "skipped")
    .map((result) => {
      if (result.messages?.length) return result
      if (result.state === "error") return { ...result, messages: [`  ${result.label}: failed — ${result.error} in ${result.path}`] }
      return { ...result, messages: [`  ${result.label}: ${result.state}`] }
    })
    .sort((a, b) => {
      const aPriority = priority.has(a.label) ? priority.get(a.label) : 100
      const bPriority = priority.has(b.label) ? priority.get(b.label) : 100
      if (aPriority !== bPriority) return aPriority - bPriority
      return a.label.localeCompare(b.label)
    })
  const labelWidth = printable.reduce((max, result) => Math.max(max, result.label.length), 0)
  const labelColumn = labelWidth + 1
  const stripKnownLabelPrefix = (message, label) => {
    const trimmed = message.trimStart()
    const prefix = `${label}:`
    return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trimStart() : trimmed
  }
  for (const result of printable) {
    for (const rawMessage of result.messages) {
      const message = stripKnownLabelPrefix(rawMessage, result.label)
      const labelCell = `${result.label}:`.padEnd(labelColumn + 1, " ")
      console.log(`  ${labelCell}${message ? ` ${message}` : ""}`)
    }
  }
}

export function geminiSettingsHasToolsmith() {
  const settings = path.join(homedir(), ".gemini", "settings.json")
  if (!existsSync(settings)) return false
  try {
    const data = JSON.parse(readFileSync(settings, "utf8"))
    return Boolean(data?.mcpServers?.toolsmith)
  } catch {
    return false
  }
}

export function setupClaudeResult(scope, force) {
  const list = tryClaude(["mcp", "list"])
  if (list === null) return clientResult("Claude Code", "skipped")
  if (list?.error) return clientResult("Claude Code", "error", `Claude Code: error checking — ${list.error}`)

  const messages = []
  const registered = list.includes("toolsmith")
  if (registered && !force) {
    const claudeGet = parseClaudeToolsmithGet()
    const drift = evaluateDrift("Claude Code", configuredMcpPath(claudeGet), realPathOrNull(MCP_BIN), claudeGet?.command)
    if (drift.state === "ok") return clientResult("Claude Code", "already", "Claude Code: already registered (--force to update)")
    messages.push("  Claude Code: path drift detected — refreshing")
  }

  if (registered) tryClaude(["mcp", "remove", "toolsmith"])

  const result = tryClaude(["mcp", "add", "--scope", scope, "toolsmith", "--", process.execPath, MCP_BIN])
  if (result?.error) {
    messages.push(`  Claude Code: failed — ${result.error}`)
    return { label: "Claude Code", state: "error", messages }
  }
  messages.push(`  Claude Code: ${registered ? "refreshed" : "registered"} (scope: ${scope})`)
  return { label: "Claude Code", state: registered ? "refreshed" : "registered", messages }
}

export function setupClaude(scope, force) {
  printClientResults([setupClaudeResult(scope, force)])
}

export function setupGeminiResult(force) {
  const list = tryGemini(["mcp", "list"])
  if (list === null) return clientResult("Gemini CLI", "skipped")
  if (list?.error) return clientResult("Gemini CLI", "error", `Gemini CLI: error checking — ${list.error}`)

  const messages = []
  const registered = list.includes("toolsmith") || geminiSettingsHasToolsmith()
  if (registered && !force) {
    const geminiConfig = parseGeminiToolsmithConfig()
    const drift = evaluateDrift("Gemini CLI", configuredMcpPath(geminiConfig), realPathOrNull(MCP_BIN), geminiConfig?.command)
    if (drift.state === "ok") return clientResult("Gemini CLI", "already", "Gemini CLI: already registered (--force to update)")
    messages.push("  Gemini CLI: path drift detected — refreshing")
  }

  if (registered) tryGemini(["mcp", "remove", "toolsmith"])
  const result = tryGemini(["mcp", "add", "--scope", "user", "--trust", "toolsmith", process.execPath, MCP_BIN])
  if (result?.error) {
    messages.push(`  Gemini CLI: failed — ${result.error}`)
    return { label: "Gemini CLI", state: "error", messages }
  }
  messages.push(`  Gemini CLI: ${registered ? "refreshed" : "registered"} (scope: user, trusted)`)
  return { label: "Gemini CLI", state: registered ? "refreshed" : "registered", messages }
}

export function setupGemini(force) {
  printClientResults([setupGeminiResult(force)])
}

export function setupCodexResult(force) {
  const codexDir = path.join(homedir(), ".codex")
  const codexConfig = path.join(codexDir, "config.toml")
  if (!existsSync(codexDir)) return clientResult("Codex", "skipped")

  const existing = existsSync(codexConfig) ? readFileSync(codexConfig, "utf8") : ""
  const registered = existing.includes("[mcp_servers.toolsmith]")
  const hasOrphans = hasToolsmithCodexOrphans(existing)
  const messages = []

  if (registered && !force && !hasOrphans) {
    const codexParsed = parseCodexToolsmithConfig()
    const drift = evaluateDrift("Codex", configuredMcpPath(codexParsed), realPathOrNull(MCP_BIN), codexParsed?.command)
    if (drift.state === "ok") return clientResult("Codex", "already", "Codex: already configured (--force to update)")
    messages.push("  Codex: path drift detected — refreshing")
  }

  const content = removeToolsmithCodexConfig(existing)
  const entry = `\n[mcp_servers.toolsmith]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(MCP_BIN)}]\n`
  try {
    writeFileSync(codexConfig, content + entry, "utf8")
    messages.push(`  Codex: ${registered || hasOrphans ? "refreshed" : "registered"}`)
    return { label: "Codex", state: registered || hasOrphans ? "refreshed" : "registered", messages }
  } catch (e) {
    messages.push(`  Codex: failed — ${e.message}`)
    return { label: "Codex", state: "error", messages }
  }
}

export function setupCodex(force) {
  printClientResults([setupCodexResult(force)])
}

export function runNpmInstallGlobal(repoRoot) {
  const result = spawnSync("npm", ["install", "-g", ".", "--silent"], { cwd: repoRoot, encoding: "utf8" })
  if (result.status === 0) console.log("  global Node install refreshed")
  else console.log(`  global Node install failed — ${(result.stderr || result.stdout || "").trim()}`)
  return result.status === 0
}

export function npmGlobalToolsmithBin(ctx = installContext()) {
  const prefixOut = ctx.npmGlobalPrefix ? null : tryCommand("npm", ["prefix", "-g"])
  const prefix = ctx.npmGlobalPrefix || (typeof prefixOut === "string" ? prefixOut.trim() : null)
  return prefix ? path.join(prefix, "bin", "toolsmith") : null
}

function quietSpawn(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", ...options, stdio: options.stdio || "pipe" })
  if (result.status === 0) return true
  const msg = (result.stderr || result.stdout || "").trim()
  if (msg) process.stderr.write(msg + "\n")
  process.exitCode = result.status || 1
  return false
}

function verboseOutput() {
  return /^(1|true|yes|on|debug|verbose)$/i.test(String(process.env.TOOLSMITH_VERBOSE || process.env.TOOLSMITH_DEBUG || ""))
}

function installSourceLabel(ctx, { detail = false } = {}) {
  if (ctx.kind === "npm-global") {
    return detail && verboseOutput() && ctx.npmGlobalToolsmithRealPath
      ? `npm at ${ctx.npmGlobalToolsmithRealPath}`
      : "npm"
  }
  if (ctx.kind === "git-checkout-canonical") {
    return detail && verboseOutput() && ctx.repoRoot ? `local checkout at ${ctx.repoRoot}` : "local checkout"
  }
  if (ctx.kind === "git-checkout-other") {
    return detail && verboseOutput() && ctx.repoRoot ? `non-canonical checkout at ${ctx.repoRoot}` : "non-canonical checkout"
  }
  return detail && verboseOutput() && ctx.binRealPath ? `unknown source at ${ctx.binRealPath}` : "unknown source"
}

export async function runSetup() {
  const ctx = installContext()
  const scope = option("--scope") || "user"
  const force = args.includes("--force")
  const wantGlobal = args.includes("--global")
  const skipSmoke = args.includes("--no-smoke")
  const skipPriming = args.includes("--no-priming")
  const suppressSummary = args.includes("--no-summary")
  const wantTripwire = args.includes("--tripwire")
  const skipCodexFooter = args.includes("--no-codex-footer")
  console.log(`Setting up toolsmith... (source: ${installSourceLabel(ctx)})\n`)
  const clientResults = [
    setupClaudeResult(scope, force),
    setupCodexResult(force),
  ]
  if (!skipCodexFooter) {
    const footer = installCodexFooter()
    const footerState = footer.status === "skipped" ? (/not found/.test(footer.message) ? "skipped" : "info") : footer.status
    clientResults.push(clientResult("Codex footer", footerState, footer.message))
  }
  const [piResult, jsonResults, geminiResult] = await Promise.all([
    Promise.resolve().then(() => setupPiResult(force)),
    setupJsonMcpClientsAsync(force),
    Promise.resolve().then(() => setupGeminiResult(force)),
  ])
  printClientResults([...clientResults, piResult, ...jsonResults, geminiResult])
  if (wantGlobal && ctx.kind.startsWith("git-checkout")) {
    runNpmInstallGlobal(ctx.repoRoot)
    console.log("  warn: this local checkout is now installed into the global Node prefix; devupgrade may replace it")
    console.log("        run 'npm uninstall -g @carlkibler/toolsmith' to remove it when done")
  } else if (ctx.kind === "git-checkout-canonical") {
    console.log("  (skipped npm install -g; pass --global to opt in)")
  }
  if (!skipPriming) {
    console.log("")
    adoptInject()
  }
  if (wantTripwire) {
    const settingsPath = installClaudeTripwire()
    console.log(`  Toolsmith tripwire: installed in ${settingsPath}`)
  }
  if (skipSmoke) {
    if (!suppressSummary) console.log("\nDone. Run 'toolsmith doctor --smoke' to verify.")
    return
  }
  process.stdout.write("\nVerifying MCP server... ")
  try {
    const toolNames = await mcpSmoke(process.execPath, [MCP_BIN])
    console.log(`✓ MCP handshake (${toolNames.length} tools)`)
    console.log("\nDone. Run 'toolsmith doctor --smoke' to verify.")
  } catch (e) {
    console.log("FAILED")
    console.error(`\n  ✗ MCP smoke test failed: ${e.message}`)
    console.error("  Config files were written, but the MCP server could not start.")
    console.error("  Run 'toolsmith doctor --smoke' for diagnostics.")
    process.exitCode = 1
  }
}

export function runAdopt() {
  const inject = args.includes("--inject")
  const remove = args.includes("--remove")
  const tripwire = args.includes("--tripwire")
  if (!inject && !remove && !tripwire) {
    console.error("Usage: toolsmith adopt --inject | --remove | --tripwire [--remove]")
    process.exitCode = 64
    return
  }
  if (tripwire) {
    if (remove) {
      const { settingsPath, removed } = removeClaudeTripwire()
      console.log(`${removed ? "removed" : "not present"}: ${settingsPath}`)
    } else {
      const settingsPath = installClaudeTripwire()
      console.log(`installed: ${settingsPath}`)
    }
    return
  }
  if (inject) {
    console.log("Injecting toolsmith priming block...\n")
    adoptInject()
    console.log("\nDone. Agents will prefer mcp__toolsmith__* on next session start.")
  } else {
    console.log("Removing toolsmith priming block...\n")
    const targets = [path.join(homedir(), ".claude", "CLAUDE.md")]
    if (existsSync(path.join(homedir(), ".codex"))) targets.push(path.join(homedir(), ".codex", "AGENTS.md"))
    if (existsSync(path.join(homedir(), ".gemini"))) targets.push(path.join(homedir(), ".gemini", "GEMINI.md"))
    const localAgents = path.join(process.cwd(), "AGENTS.md")
    if (existsSync(localAgents)) targets.push(localAgents)
    for (const target of targets) removePrimingBlock(target)
    console.log("\nDone.")
  }
}

export function runUpdate() {
  const ctx = installContext()
  const currentVersion = packageInfo().version || "unknown"
  const refreshSetup = !args.includes("--no-setup")
  const checkOnly = args.includes("--check")
  const fromPath = option("--from")
  const useGithub = args.includes("--github")
  const release = useGithub && !fromPath ? githubLatestRelease("carlkibler", "toolsmith") : null
  const globalBin = npmGlobalToolsmithBin(ctx)

  let source, sourceLabel
  if (fromPath) {
    source = path.resolve(fromPath)
    sourceLabel = "local"
  } else if (useGithub) {
    source = release?.tag ? `github:carlkibler/toolsmith#${release.tag}` : "github:carlkibler/toolsmith"
    sourceLabel = release?.tag ? `github (${release.tag})` : "github (latest)"
  } else {
    source = "@carlkibler/toolsmith"
    sourceLabel = "npm"
  }

  function refreshInstalledSetup() {
    if (!refreshSetup) return true
    if (!globalBin || !existsSync(globalBin)) {
      console.error(`Installed toolsmith binary not found at ${globalBin || "(unknown global Node prefix)"}.`)
      process.exitCode = 1
      return false
    }
    const setupArgs = ["setup", "--force", "--no-smoke", "--no-priming", "--no-summary"]
    const scope = option("--scope")
    if (scope) setupArgs.push("--scope", scope)
    if (args.includes("--no-codex-footer")) setupArgs.push("--no-codex-footer")
    const result = spawnSync(globalBin, setupArgs, { stdio: "inherit" })
    if (result.status !== 0) {
      process.exitCode = result.status || 1
      return false
    }
    return true
  }

  if (checkOnly) {
    console.log(`current: v${currentVersion} (${installSourceLabel(ctx, { detail: true })})`)
    if (fromPath) {
      console.log(`update source: local path ${source}`)
    } else if (useGithub) {
      const latestVersion = release?.tag?.replace(/^v/, "") || null
      const dateStr = release?.publishedAt ? `, published ${release.publishedAt.slice(0, 10)}` : ""
      console.log(latestVersion ? `latest github release: ${release.tag}${dateStr}` : "latest github release: unknown (network error?)")
    } else {
      const npmLatest = tryCommand("npm", ["view", "@carlkibler/toolsmith", "version"])
      console.log(typeof npmLatest === "string" ? `latest npm: v${npmLatest.trim()}` : "latest npm: unknown (network error?)")
    }
    return
  }

  if (fromPath && !existsSync(source)) {
    console.error(`Local update source does not exist: ${source}`)
    process.exitCode = 1
    return
  }

  console.log(`Updating toolsmith from ${sourceLabel}... (current: v${currentVersion})`)
  quietSpawn("npm", ["uninstall", "-g", "@carlkibler/toolsmith", "--silent"])
  if (process.exitCode) return
  if (!quietSpawn("npm", ["install", "-g", source, "--silent"])) return

  if (!refreshInstalledSetup()) return
  console.log("\nDone. Run 'toolsmith doctor --smoke' to verify.")
}
