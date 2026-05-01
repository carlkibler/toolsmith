#!/usr/bin/env node
import fs from "node:fs/promises"
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import path from "node:path"
import { WorkspaceTools } from "../src/fs-tools.js"

const command = process.argv[2]
const args = process.argv.slice(3)
const tools = new WorkspaceTools({ cwd: process.cwd() })

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MCP_BIN = path.join(__dirname, "toolsmith-mcp.mjs")

function usage() {
  console.error(`Usage:
  toolsmith read <path> [--start N] [--end N] [--session ID]
  toolsmith search <path> <query> [--regex] [--case-sensitive] [--context N] [--max N] [--session ID]
  toolsmith skeleton <path> [--max N] [--session ID]
  toolsmith get-function <path> <name> [--context N] [--max N] [--session ID]
  toolsmith symbol-replace <path> <name> --search TEXT --replacement TEXT [--regex] [--all] [--ignore-case] [--dry-run] [--session ID]
  toolsmith edit <path> --edits edits.json [--dry-run] [--session ID]
  toolsmith edit-many files.json [--dry-run] [--session ID]
  toolsmith mcp
  toolsmith setup [--scope user|project|local] [--force]
  toolsmith doctor
`)
}

function option(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function tryClaude(claudeArgs) {
  try {
    return execFileSync("claude", claudeArgs, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
  } catch (e) {
    if (e.code === "ENOENT") return null
    return { error: (e.stderr?.toString() || e.message || "").trim() }
  }
}

function setupClaude(scope, force) {
  const list = tryClaude(["mcp", "list"])
  if (list === null) { console.log("  claude: not found — skipping"); return }
  if (list?.error) { console.log(`  Claude Code: error checking — ${list.error}`); return }

  const registered = list.includes("toolsmith")
  if (registered && !force) { console.log("  Claude Code: already registered (--force to update)"); return }

  if (registered) tryClaude(["mcp", "remove", "toolsmith"])

  const result = tryClaude(["mcp", "add", "--scope", scope, "toolsmith", "--", process.execPath, MCP_BIN])
  if (result?.error) {
    console.log(`  Claude Code: failed — ${result.error}`)
  } else {
    console.log(`  Claude Code: registered (scope: ${scope})`)
  }
}

function setupCodex(force) {
  const codexDir = path.join(homedir(), ".codex")
  const codexConfig = path.join(codexDir, "config.toml")
  if (!existsSync(codexDir)) { console.log("  Codex: not found — skipping"); return }

  const existing = existsSync(codexConfig) ? readFileSync(codexConfig, "utf8") : ""
  const registered = existing.includes("[mcp_servers.toolsmith]")

  if (registered && !force) { console.log("  Codex: already configured (--force to update)"); return }

  let content = existing
  if (registered) {
    // Remove the existing toolsmith block (up to the next section header or EOF)
    content = existing.replace(/\n?\[mcp_servers\.toolsmith\][^\[]*/, "").trimEnd() + "\n"
  }

  const entry = `\n[mcp_servers.toolsmith]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(MCP_BIN)}]\n`
  try {
    writeFileSync(codexConfig, content + entry, "utf8")
    console.log(`  Codex: ${registered ? "updated" : "registered"}`)
  } catch (e) {
    console.log(`  Codex: failed — ${e.message}`)
  }
}

function runSetup() {
  const scope = option("--scope") || "user"
  const force = args.includes("--force")
  console.log("Setting up toolsmith...\n")
  setupClaude(scope, force)
  setupCodex(force)
  console.log("\nDone. Run 'toolsmith doctor' to verify.")
}

function runDoctor() {
  let warnings = 0
  const ok = (msg) => console.log(`  ok   ${msg}`)
  const warn = (msg) => { console.log(`  warn ${msg}`); warnings++ }
  const info = (msg) => console.log(`  info ${msg}`)

  console.log("toolsmith doctor\n")

  const major = Number(process.version.slice(1).split(".")[0])
  if (major < 20) warn(`Node.js ${process.version} — need >=20`); else ok(`Node.js ${process.version}`)

  if (existsSync(MCP_BIN)) ok(`toolsmith-mcp at ${MCP_BIN}`); else warn(`toolsmith-mcp not found at ${MCP_BIN}`)

  const list = tryClaude(["mcp", "list"])
  if (list === null) {
    info("claude not found")
  } else if (list?.error) {
    warn(`Claude Code check failed — ${list.error}`)
  } else if (list.includes("toolsmith")) {
    ok("Claude Code: toolsmith registered")
  } else {
    warn("Claude Code: toolsmith not registered — run 'toolsmith setup'")
  }

  const codexConfig = path.join(homedir(), ".codex", "config.toml")
  if (!existsSync(path.join(homedir(), ".codex"))) {
    info("Codex not found")
  } else if (existsSync(codexConfig) && readFileSync(codexConfig, "utf8").includes("[mcp_servers.toolsmith]")) {
    ok("Codex: toolsmith registered")
  } else {
    warn("Codex: toolsmith not registered — run 'toolsmith setup'")
  }

  console.log(warnings > 0 ? `\n${warnings} warning(s).` : "\nAll checks passed.")
  if (warnings > 0) process.exitCode = 1
}

try {
  if (command === "mcp") {
    await import("./toolsmith-mcp.mjs")
  } else if (command === "setup") {
    runSetup()
  } else if (command === "doctor") {
    runDoctor()
  } else if (command === "read") {
    const target = args[0]
    const result = await tools.read({
      path: target,
      sessionId: option("--session") || "cli",
      startLine: option("--start") ? Number(option("--start")) : undefined,
      endLine: option("--end") ? Number(option("--end")) : undefined,
    })
    console.log(result.text)
  } else if (command === "search") {
    const target = args[0]
    const query = args[1]
    const result = await tools.search({
      path: target,
      query,
      sessionId: option("--session") || "cli",
      regex: args.includes("--regex"),
      caseSensitive: args.includes("--case-sensitive"),
      contextLines: option("--context") ? Number(option("--context")) : undefined,
      maxMatches: option("--max") ? Number(option("--max")) : undefined,
    })
    console.log(result.text)
  } else if (command === "skeleton") {
    const target = args[0]
    const result = await tools.skeleton({
      path: target,
      sessionId: option("--session") || "cli",
      maxLines: option("--max") ? Number(option("--max")) : undefined,
    })
    console.log(result.text)
  } else if (command === "get-function") {
    const target = args[0]
    const name = args[1]
    const result = await tools.getFunction({
      path: target,
      name,
      sessionId: option("--session") || "cli",
      contextLines: option("--context") ? Number(option("--context")) : undefined,
      maxLines: option("--max") ? Number(option("--max")) : undefined,
    })
    console.log(result.text)
    process.exitCode = result.found === false ? 2 : 0
  } else if (command === "symbol-replace") {
    const target = args[0]
    const name = args[1]
    const search = option("--search")
    if (!search) throw new Error("--search is required")
    const result = await tools.symbolReplace({
      path: target,
      name,
      search,
      replacement: option("--replacement") || "",
      sessionId: option("--session") || "cli",
      regex: args.includes("--regex"),
      replaceAll: args.includes("--all"),
      caseSensitive: !args.includes("--ignore-case"),
      dryRun: args.includes("--dry-run"),
    })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.ok ? 0 : 2
  } else if (command === "edit") {
    const target = args[0]
    const editsPath = option("--edits")
    if (!editsPath) throw new Error("--edits is required")
    const edits = JSON.parse(await fs.readFile(editsPath, "utf8"))
    const result = await tools.edit({
      path: target,
      sessionId: option("--session") || "cli",
      edits,
      dryRun: args.includes("--dry-run"),
    })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.ok ? 0 : 2
  } else {
    usage()
    process.exitCode = 64
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
