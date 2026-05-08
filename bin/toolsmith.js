#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceTools } from "../src/fs-tools.js"
import { command, args, option, positionals } from "../lib/argv.js"
import { packageInfo, MCP_BIN } from "../lib/config.js"
import { runSetup, runAdopt, runUpdate } from "../lib/setup.js"
import { runAudit, runAgentLogScan, runOpportunities, runAdoptionSnippet, runCharm } from "../lib/audit.js"
import { runDoctor } from "../lib/doctor.js"
import { runPi } from "../lib/pi.js"
import { runTripwire } from "../lib/tripwire.js"

{
  const major = Number(process.versions.node.split(".")[0])
  if (major < 20) {
    process.stderr.write(`toolsmith requires Node 20+; current: ${process.versions.node}\nTry: nvm install 20 && nvm use 20\n`)
    process.exit(64)
  }
}

const tools = new WorkspaceTools({ cwd: process.cwd() })

function usage() {
  console.error(`Usage: toolsmith <command> [options]

Install / health
  setup|install  [--scope user|project|local] [--force] [--global] [--no-smoke] [--no-priming] [--no-summary] [--no-codex-footer] [--tripwire]
                 Register MCP with Claude Code, Codex, and Gemini. Injects preference hints.
  adopt          --inject | --remove
                 Add or remove toolsmith preference block from CLAUDE.md / AGENTS.md.
  doctor|doc     [--fix [--yes]] [--smoke] [--online] [--live-agent]
                 Check registration, drift, adoption, and log health. --fix self-repairs.
  update         [--github] [--from PATH] [--no-setup] [--no-codex-footer] [--check]
                 Install latest npm release and refresh clients; --github uses GitHub releases, --from uses local path.
  pi             [--with-builtins] [pi args...]
                 Run Pi.dev with Toolsmith tools as the default strict edit harness.
  tripwire      run|install|remove|status|snippet [--client claude|codex|all]
                 Nudge native large-file reads/edits toward Toolsmith and log fires.

Audit
  audit          [--days N] [--tail N] [--log PATH] [--json]  Summarize recent usage.
  scan-agent-logs [--days N] [--json] [--markdown] [--remote HOST] [--max-examples N]
  opportunities  [--days N] [--json] [--remote HOST]      Lost-opportunity report.
  adoption-snippet [--client claude|codex|gemini|all]     Print CLAUDE.md snippet.
  charm          [--lines N]                              Demo token savings on a fake file.

Edit primitives (for agents via MCP — prefer mcp__toolsmith__* over CLI in agent contexts)
  mcp                                              Start MCP stdio server.
  skeleton       <path> [--max N] [--session ID]
  get-function   <path> <name> [--context N] [--max N] [--session ID]
  find-and-anchor [path] <query> [--glob PAT] [--regex] [--case-sensitive] [--context N] [--max N] [--session ID]
  search         <path> <query> [--regex] [--case-sensitive] [--context N] [--max N] [--session ID]
  read           <path> [--start N] [--end N] [--session ID]
  symbol-replace <path> <name> --search TEXT --replacement TEXT [--regex] [--all] [--ignore-case] [--dry-run] [--session ID]
  edit           <path> --edits edits.json [--dry-run] [--session ID]
  edit-many      files.json [--dry-run] [--session ID]
`)
}

try {
  if (command === "--version" || command === "-v") {
    console.log(packageInfo().version || "unknown")
  } else if (command === "mcp") {
    await import("./toolsmith-mcp.js")
  } else if (command === "--print-context") {
    const { installContext } = await import("../lib/config.js")
    console.log(JSON.stringify(installContext(), null, 2))
  } else if (command === "setup" || command === "install") {
    await runSetup()
  } else if (command === "adopt") {
    runAdopt()
  } else if (command === "doctor" || command === "doc") {
    await runDoctor()
  } else if (command === "update") {
    runUpdate()
  } else if (command === "pi") {
    runPi()
  } else if (command === "tripwire") {
    await runTripwire()
  } else if (command === "audit") {
    await runAudit()
  } else if (command === "scan-agent-logs") {
    await runAgentLogScan()
  } else if (command === "opportunities") {
    await runOpportunities()
  } else if (command === "adoption-snippet") {
    runAdoptionSnippet()
  } else if (command === "charm") {
    await runCharm()
  } else if (command === "read") {
    const target = args[0]
    const result = await tools.read({
      path: target,
      sessionId: option("--session") || "cli",
      startLine: option("--start") ? Number(option("--start")) : undefined,
      endLine: option("--end") ? Number(option("--end")) : undefined,
    })
    console.log(result.text)
  } else if (command === "find-and-anchor") {
    const positional = positionals()
    const explicitQuery = option("--query")
    const target = option("--path") || (explicitQuery && positional.length ? positional[0] : positional.length > 1 ? positional[0] : ".")
    const query = explicitQuery || (positional.length > 1 ? positional[1] : positional[0])
    if (!query) throw new Error("find-and-anchor requires a query")
    const result = await tools.findAndAnchor({
      path: target,
      query,
      sessionId: option("--session") || "cli",
      glob: option("--glob"),
      regex: args.includes("--regex"),
      caseSensitive: args.includes("--case-sensitive"),
      contextLines: option("--context") ? Number(option("--context")) : undefined,
      maxMatches: option("--max") ? Number(option("--max")) : undefined,
      maxFiles: option("--max-files") ? Number(option("--max-files")) : undefined,
      maxMatchesPerFile: option("--max-per-file") || option("--max-matches-per-file") ? Number(option("--max-per-file") || option("--max-matches-per-file")) : undefined,
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
    let edits
    try {
      edits = JSON.parse(await fs.readFile(editsPath, "utf8"))
    } catch (e) {
      throw new Error(`Could not parse edits file "${editsPath}": ${e.message}`)
    }
    const result = await tools.edit({
      path: target,
      sessionId: option("--session") || "cli",
      edits,
      dryRun: args.includes("--dry-run"),
    })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.ok ? 0 : 2
  } else if (command === "edit-many") {
    const filesPath = args[0]
    if (!filesPath) throw new Error("edit-many requires a JSON file argument")
    let files
    try {
      files = JSON.parse(await fs.readFile(filesPath, "utf8"))
    } catch (e) {
      throw new Error(`Could not parse files JSON "${filesPath}": ${e.message}`)
    }
    const result = await tools.editMany({
      files,
      sessionId: option("--session") || "cli",
      dryRun: args.includes("--dry-run"),
    })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.ok ? 0 : 2
  } else {
    usage()
    if (command) process.exitCode = 64  // unknown command; no-args is just a help request
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
