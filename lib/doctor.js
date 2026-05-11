import { existsSync, mkdirSync, appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import path from "node:path"
import { configuredUsageLogPath, isLikelyHarnessRecord, summarizeUsage } from "../src/usage-log.js"
import { args, option } from "./argv.js"
import { MCP_BIN, realPathOrNull, packageInfo, gitRoot, gitRemote, gitBranch, gitHead, gitDirty, fetchAndGetAheadBehind, isCanonicalRepo, parseClaudeToolsmithGet, parseGeminiToolsmithConfig, parseCodexToolsmithConfig, parseCodexApprovalPolicy, parsePiToolsmithConfig, installContext, configuredMcpPath, evaluateDrift, tryCommand, mcpSmoke } from "./config.js"
import { setupClaude, setupGemini, setupCodex, adoptInject, runNpmInstallGlobal, tryClaude, tryGemini, geminiSettingsHasToolsmith, promptYN } from "./setup.js"
import { PI_TOOLSMITH_TOOLS, piInstallHealth, piPackageSource, setupPi, tryPi } from "./pi.js"
import { doctorJsonMcpClients, setupJsonMcpClients } from "./client-mcp.js"
import { usageHealth, latestBy, formatCounts, efficiencyLine, agentEfficiencyLine, telemetryStats, clientAdoptionHints, relativeTime } from "./audit.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, "..")
const BIN_PATH = path.join(REPO_ROOT, "bin", "toolsmith.js")

function verboseOutput() {
  return envEnabled(process.env.TOOLSMITH_VERBOSE) || envEnabled(process.env.TOOLSMITH_DEBUG)
}

function envEnabled(value) {
  return /^(1|true|yes|on|debug|verbose)$/i.test(String(value || ""))
}

function runLiveAgentDoctor() {
  const script = path.join(REPO_ROOT, "scripts", "test-harnesses.sh")
  if (!existsSync(script)) {
    return { ok: false, message: `live-agent harness missing at ${script}` }
  }
  const liveArgs = ["--skip-local"]
  if (tryCommand("codex", ["--version"]) !== null) liveArgs.push("--live-codex")
  if (tryCommand("gemini", ["--version"]) !== null) liveArgs.push("--live-gemini")
  if (tryCommand("pi", ["--version"]) !== null) liveArgs.push("--live-pi")
  if (liveArgs.length === 1) return { ok: false, message: "no supported live-agent clients found (codex, gemini, pi)" }
  const result = spawnSync(script, liveArgs, { cwd: REPO_ROOT, stdio: "inherit" })
  return { ok: result.status === 0, message: "", status: result.status }
}

export async function runDoctor() {
  let warnings = 0
  const jsonMode = args.includes("--json")
  const report = { warnings: [], checks: [] }
  const ok = (msg) => { if (!jsonMode) console.log(`  ok   ${msg}`); report.checks.push({ level: "ok", msg }) }
  const warn = (msg) => { if (!jsonMode) console.log(`  warn ${msg}`); warnings++; report.warnings.push(msg); report.checks.push({ level: "warn", msg }) }
  const info = (msg) => { if (!jsonMode) console.log(`  info ${msg}`); report.checks.push({ level: "info", msg }) }
  const section = (name) => { if (!jsonMode) console.log(name) }
  const fix = args.includes("--fix")
  const smoke = args.includes("--smoke")
  const online = args.includes("--online")
  const liveAgent = args.includes("--live-agent")
  const needsFix = new Set()

  if (!jsonMode) console.log("toolsmith doctor\n")

  const pkg = packageInfo()
  const repoRoot = gitRoot()
  const expectedMcpPath = realPathOrNull(MCP_BIN)
  const remote = gitRemote(repoRoot)
  const branch = gitBranch(repoRoot)
  const head = gitHead(repoRoot)

  section("\nprovenance")
  ok(`toolsmith ${pkg.version || "unknown"} at ${realPathOrNull(BIN_PATH) || BIN_PATH}`)
  if (expectedMcpPath) ok(`toolsmith-mcp at ${expectedMcpPath}`); else warn(`toolsmith-mcp not found at ${MCP_BIN}`)
  if (!repoRoot) {
    warn("not running from a git checkout; cannot verify canonical repo")
  } else {
    ok(`git repo ${repoRoot}${head ? ` @ ${head}` : ""}${branch ? ` (${branch})` : ""}`)
    if (isCanonicalRepo(remote)) ok(`canonical remote ${remote}`); else warn(`non-canonical remote ${remote || "none"}`)
    if (branch && branch !== "main") warn(`not on main branch (${branch})`)
    if (gitDirty(repoRoot)) warn("working tree has uncommitted changes")
    if (online) {
      const ab = fetchAndGetAheadBehind(repoRoot)
      if (ab) {
        if (ab.behind > 0) warn(`behind origin/main by ${ab.behind} commit(s)`)
        else ok("up to date with origin/main")
        if (ab.ahead > 0) info(`ahead of origin/main by ${ab.ahead} commit(s)`)
      }
    }
  }

  if (online) ok(`version ${pkg.version} (distributed via github:carlkibler/toolsmith)`)

  section("\nruntime")
  const major = Number(process.version.slice(1).split(".")[0])
  if (major < 20) warn(`Node.js ${process.version} — need >=20`); else ok(`Node.js ${process.version}`)

  section("\nclient registrations")
  const list = tryClaude(["mcp", "list"])
  if (list === null) {
    info("claude not found")
  } else if (list?.error) {
    warn(`Claude Code check failed — ${list.error}`)
  } else if (list.includes("toolsmith")) {
    ok("Claude Code: toolsmith registered")
    const claudeGet = parseClaudeToolsmithGet()
    if (claudeGet) {
      const drift = evaluateDrift("Claude Code", configuredMcpPath(claudeGet), expectedMcpPath, claudeGet.command)
      if (drift.state === "ok") ok("Claude Code: command points at this checkout")
      else { warn(drift.message || "Claude Code: registered path does not match this checkout"); needsFix.add("claude") }
    }
  } else {
    warn("Claude Code: toolsmith not registered — run 'toolsmith setup'")
    needsFix.add("claude")
  }

  const geminiConfig = parseGeminiToolsmithConfig()
  const geminiList = tryGemini(["mcp", "list"])
  if (geminiList === null) {
    info("Gemini CLI not found")
  } else if (geminiList?.error) {
    warn(`Gemini CLI check failed — ${geminiList.error}`)
  } else if (geminiList.includes("toolsmith") || geminiSettingsHasToolsmith()) {
    ok("Gemini CLI: toolsmith registered")
    if (geminiConfig?.error) {
      warn(`Gemini CLI: ${geminiConfig.error} in ${geminiConfig.path}`)
    } else {
      const drift = evaluateDrift("Gemini CLI", configuredMcpPath(geminiConfig), expectedMcpPath, geminiConfig?.command)
      if (drift.state === "ok") ok("Gemini CLI: command points at this checkout")
      else { warn(drift.message || "Gemini CLI: registered path does not match this checkout"); needsFix.add("gemini") }
      if (geminiConfig?.trust === true) ok("Gemini CLI: trust enabled")
      else { warn("Gemini CLI: trust is not enabled for toolsmith"); needsFix.add("gemini") }
    }
  } else {
    warn("Gemini CLI: toolsmith not registered — run 'toolsmith setup --force'")
    needsFix.add("gemini")
  }

  const codexToolsmith = parseCodexToolsmithConfig()
  const codexConfig = path.join(homedir(), ".codex", "config.toml")
  if (!existsSync(path.join(homedir(), ".codex"))) {
    info("Codex not found")
  } else if (codexToolsmith?.error) {
    warn(`Codex: config unreadable (${codexToolsmith.error}) at ${codexToolsmith.path}`)
    needsFix.add("codex")
  } else if (codexToolsmith) {
    ok("Codex: toolsmith registered")
    const drift = evaluateDrift("Codex", configuredMcpPath(codexToolsmith), expectedMcpPath, codexToolsmith.command)
    if (drift.state === "ok") ok("Codex: command points at this checkout")
    else { warn(drift.message || "Codex: registered path does not match this checkout"); needsFix.add("codex") }
    const chezmoiSource = tryCommand("chezmoi", ["source-path", codexConfig])
    if (typeof chezmoiSource === "string" && chezmoiSource.trim()) info(`Codex config managed by chezmoi source ${chezmoiSource.trim()}`)
  } else {
    warn("Codex: toolsmith not registered — run 'toolsmith setup'")
    needsFix.add("codex")
  }

  const codexApprovalPolicy = parseCodexApprovalPolicy()
  if (codexApprovalPolicy && codexApprovalPolicy !== "never" && codexToolsmith?.command) {
    warn(`Codex approval_policy='${codexApprovalPolicy}' may silently cancel anchored_edit calls; in disposable workspaces set approval_policy = "never" or use --full-auto`)
  }

  const piVersion = tryPi(["--version"])
  const piConfig = parsePiToolsmithConfig()
  const piHealth = piInstallHealth(piConfig, piPackageSource())
  if (piVersion === null && !existsSync(path.join(homedir(), ".pi"))) {
    info("Pi.dev not found")
  } else if (piVersion === null) {
    warn("Pi.dev: settings exist but `pi` command is not on PATH")
  } else if (piVersion?.error) {
    warn(`Pi.dev: error checking CLI — ${piVersion.error}`)
  } else if (piHealth.state === "error") {
    warn(`Pi.dev: ${piHealth.error} in ${piHealth.path}`)
  } else if (piHealth.state === "ok") {
    ok(`Pi.dev: toolsmith package installed (${piHealth.installed})`)
    info(`Pi.dev strict harness: toolsmith pi --print \"...\" (tools: ${PI_TOOLSMITH_TOOLS.length})`)
  } else if (piHealth.state === "drift") {
    warn(`Pi.dev: toolsmith package points at ${piHealth.installedRealPath || piHealth.installed || "unknown"}, expected ${piHealth.expectedRealPath}`)
    needsFix.add("pi")
  } else {
    warn(`Pi.dev: toolsmith package not installed — run 'pi install ${piHealth.source}'`)
    needsFix.add("pi")
  }

  for (const client of doctorJsonMcpClients(expectedMcpPath)) {
    if (client.state === "missing") {
      info(`${client.label} not found`)
    } else if (client.state === "ok") {
      ok(`${client.label}: toolsmith registered`)
      ok(`${client.label}: command points at this checkout`)
    } else if (client.state === "error") {
      warn(`${client.label}: ${client.error} in ${client.path}`)
      needsFix.add("json-mcp")
    } else if (client.state === "unregistered") {
      warn(`${client.label}: toolsmith not registered — run 'toolsmith setup --force'`)
      needsFix.add("json-mcp")
    } else if (client.state === "disabled") {
      warn(`${client.label}: toolsmith server is disabled — run 'toolsmith setup --force'`)
      needsFix.add("json-mcp")
    } else {
      warn(client.message || `${client.label}: registered path does not match this checkout`)
      needsFix.add("json-mcp")
    }
  }

  const installCtx = installContext()
  if (installCtx.kind !== "npm-global" && installCtx.npmGlobalIsLive) {
    const currentRoot = realPathOrNull(REPO_ROOT)
    if (installCtx.npmGlobalToolsmithRealPath === currentRoot) {
      info(`global Node install links to this checkout${verboseOutput() ? ` (${installCtx.npmGlobalToolsmithPath})` : ""}`)
    } else {
      warn(`stale global Node install${verboseOutput() ? ` at ${installCtx.npmGlobalToolsmithPath}` : ""} — run 'toolsmith doctor --fix' to remove`)
      needsFix.add("stale-npm-global")
    }
  }

  if (smoke) {
    section("\nMCP smoke test")
    try {
      const toolNames = await mcpSmoke(process.execPath, [MCP_BIN])
      const expectedTools = ["anchored_edit", "anchored_read", "anchored_search", "file_skeleton", "find_and_anchor", "get_function", "symbol_replace"]
      const missing = expectedTools.filter((tool) => !toolNames.includes(tool))
      if (missing.length) warn(`MCP handshake succeeded but missing tools: ${missing.join(", ")}`)
      else ok(`MCP handshake/list-tools succeeded (${toolNames.length} tools)`)
    } catch (e) {
      warn(`MCP smoke test failed — ${e.message}`)
    }
  }

  if (liveAgent) {
    section("\nlive-agent verification")
    const result = runLiveAgentDoctor()
    if (result.ok) ok("live-agent harness passed")
    else warn(`live-agent harness failed${result.status ? ` (exit ${result.status})` : ""}`)
    if (result.message) console.log(result.message.split(/\r?\n/).map((line) => `  info ${line}`).join("\n"))
  }

  section("\nusage health")
  try {
    const probePath = configuredUsageLogPath()
    if (probePath) {
      try {
        mkdirSync(path.dirname(probePath), { recursive: true })
        appendFileSync(probePath, "")
        ok(`usage log writable at ${probePath}`)
      } catch (e) {
        warn(`usage log NOT writable at ${probePath} (${e.code || e.message}) — audit will show no adoption even if agents call tools`)
      }
    }
    const { logPath, records } = await usageHealth()
    const summary = summarizeUsage(records)
    info(`usage log ${logPath}`)
    info(`events: ${summary.totalEvents} (${summary.toolCalls} tool calls, ${summary.startupEvents} startups, ${summary.toolsListEvents} tool-list requests, ${summary.errors} errors)`)
    info(`non-test agent tool calls: ${summary.agentToolCalls}; harness/test tool calls: ${summary.harnessToolCalls}`)
    info(`startup clients: ${formatCounts(summary.startupClients)}`)
    info(`tool-list clients: ${formatCounts(summary.toolsListClients)}`)
    info(`non-test tool-list clients: ${formatCounts(summary.agentToolsListClients)}`)
    info(`tool-call clients: ${formatCounts(summary.clients)}`)
    info(`non-test tool-call clients: ${formatCounts(summary.agentClients)}`)
    info(`tools: ${formatCounts(summary.tools)}`)
    info(`non-test tools: ${formatCounts(summary.agentTools)}`)
    info(`startup workspaces: ${formatCounts(summary.startupWorkspaceNames, 12)}`)
    info(`tool-call workspaces: ${formatCounts(summary.toolCallWorkspaceNames, 12)}`)
    info(`non-test tool-call workspaces: ${formatCounts(summary.agentWorkspaceNames, 12)}`)
    info(`edits: ${summary.editCalls} edit/replace calls (${summary.changedCalls} changed files)`)
    info(`non-test edits: ${summary.agentEditCalls} edit/replace calls (${summary.agentChangedCalls} changed files)`)
    info(`efficiency: ${efficiencyLine(summary)}`)
    const allTelemetry = telemetryStats(records)
    const agentTelemetry = telemetryStats(records.filter((record) => record.event !== "tool_call" || !isLikelyHarnessRecord(record)))
    info(`savings-positive calls: ${allTelemetry.positiveSavings}/${allTelemetry.telemetryCount}; largest measured file: ${allTelemetry.maxFullBytes} bytes`)
    info(`non-test efficiency: ${agentEfficiencyLine(summary)}`)
    if (summary.agentToolCalls) info(`non-test savings-positive calls: ${agentTelemetry.positiveSavings}/${agentTelemetry.telemetryCount}; largest measured file: ${agentTelemetry.maxFullBytes} bytes`)
    if (summary.toolCalls && summary.estimatedTokensAvoided === 0) {
      info("efficiency note: zero means recent measured calls were tiny or full-file-equivalent; savings should appear on partial reads/searches/skeletons over larger files")
    }
    const adoptionHints = clientAdoptionHints(summary)
    if (adoptionHints.length) {
      for (const hint of adoptionHints) warn(`registered but ignored: ${hint}`)
      info("prompt nudge: ask the agent to use toolsmith file_skeleton/search/get_function before reading large files")
      info("live proof: toolsmith doctor --live-agent")
    }
    const latestStartup = latestBy(records, (record) => record.event === "startup")
    const latestCall = latestBy(records, (record) => record.event === "tool_call")
    const latestAgentCall = latestBy(records, (record) => record.event === "tool_call" && !isLikelyHarnessRecord(record))
    if (latestStartup) ok(`latest startup ${latestStartup.client || "unknown"} at ${latestStartup.ts} (${relativeTime(latestStartup.ts)})`)
    else warn("no startup events recorded in the last 7 days")
    if (latestCall) ok(`latest tool call ${latestCall.client || "unknown"}/${latestCall.tool || "unknown"} at ${latestCall.ts} (${relativeTime(latestCall.ts)})`)
    else warn("no tool calls recorded in the last 7 days")
    if (latestAgentCall) ok(`latest agent tool call ${latestAgentCall.client}/${latestAgentCall.tool || "unknown"} at ${latestAgentCall.ts} (${relativeTime(latestAgentCall.ts)})`)
    else {
      info("no non-test agent tool calls recorded in the last 7 days")
      info("→ run `toolsmith adopt --inject` to add preference hints to CLAUDE.md/AGENTS.md")
    }
    info("details: toolsmith audit --days 7")
    info("machine-readable: toolsmith audit --days 7 --json")
  } catch (e) {
    warn(`usage health check failed — ${e.message}`)
  }

  const registrationFixes = new Set(["claude", "codex", "gemini", "pi", "json-mcp", "stale-npm-global"])
  const hasRegistrationFixes = [...needsFix].some((k) => registrationFixes.has(k))
  if (fix && !hasRegistrationFixes && needsFix.has("adoption-gap")) {
    console.log("\n(--fix: no registration issues to repair)")
    console.log("  adoption gap detected — run `toolsmith adopt --inject` to add preference hints, or pass --yes to inject now")
    const yesAll = args.includes("--yes") || args.includes("-y")
    if (yesAll || promptYN("Inject toolsmith priming into CLAUDE.md/AGENTS.md now?", yesAll)) {
      section("\nfix")
      console.log("  Injecting priming block...")
      adoptInject()
    }
  } else if (fix && !hasRegistrationFixes && warnings > 0) {
    console.log("\n(--fix: no registration issues to repair; warnings above require manual action)")
  }
  if (fix && hasRegistrationFixes) {
    const ctx = installContext()
    const yesAll = args.includes("--yes") || args.includes("-y")
    if (!process.stdin.isTTY && !yesAll) {
      console.error("\n  stdin is not a TTY — rerun with --yes to auto-confirm all fixes, or run interactively.")
    } else {
      section("\nfix")
      if (needsFix.has("claude") && promptYN("Re-register Claude Code to point at this checkout?", yesAll)) {
        setupClaude(option("--scope") || "user", true)
      }
      if (needsFix.has("codex") && promptYN("Re-register Codex to point at this checkout?", yesAll)) {
        setupCodex(true)
      }
      if (needsFix.has("gemini") && promptYN("Re-register Gemini CLI to point at this checkout?", yesAll)) {
        setupGemini(true)
      }
      if (needsFix.has("pi")) {
        const piList = tryPi(["list"])
        if (piList !== null && promptYN("Install toolsmith for Pi.dev?", yesAll)) setupPi(true)
      }
      if (needsFix.has("json-mcp") && promptYN("Re-register OpenCode/Cline/Cursor MCP configs to point at this checkout?", yesAll)) {
        for (const result of setupJsonMcpClients(true)) {
          if (result.state === "skipped") info(`${result.label}: not found — skipping`)
          else if (result.state === "error") warn(`${result.label}: ${result.error} in ${result.path}`)
          else ok(`${result.label}: ${result.state}`)
        }
      }
      if (ctx.kind === "npm-global" && ctx.repoRoot) {
        runNpmInstallGlobal(ctx.repoRoot)
      }
      if (needsFix.has("stale-npm-global") && promptYN("Remove stale global Node install? (npm uninstall -g @carlkibler/toolsmith)", yesAll)) {
        const uninstall = spawnSync("npm", ["uninstall", "-g", "@carlkibler/toolsmith"], { encoding: "utf8" })
        if (uninstall.status === 0) ok("stale global Node install removed")
        else warn(`npm uninstall failed — ${(uninstall.stderr || uninstall.stdout || "").trim()}`)
      }
      if (needsFix.has("adoption-gap") && promptYN("Inject toolsmith priming into CLAUDE.md/AGENTS.md?", yesAll)) {
        console.log("  Injecting priming block...")
        adoptInject()
      }
    }
  }

  if (jsonMode) {
    report.ok = warnings === 0
    report.warningCount = warnings
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(warnings > 0 ? `\n${warnings} warning(s).` : "\nAll checks passed.")
  }
  if (warnings > 0) process.exitCode = 1
}
