#!/usr/bin/env node
import fs from "node:fs/promises"
import { WorkspaceTools } from "../src/fs-tools.js"

const command = process.argv[2]
const args = process.argv.slice(3)
const tools = new WorkspaceTools({ cwd: process.cwd() })

function usage() {
  console.error(`Usage:
  dirac-edit-core read <path> [--start N] [--end N] [--session ID]
  dirac-edit-core search <path> <query> [--regex] [--case-sensitive] [--context N] [--max N] [--session ID]
  dirac-edit-core skeleton <path> [--max N] [--session ID]
  dirac-edit-core get-function <path> <name> [--context N] [--max N] [--session ID]
  dirac-edit-core edit <path> --edits edits.json [--dry-run] [--session ID]
  dirac-edit-core edit-many files.json [--dry-run] [--session ID]
  dirac-edit-core mcp
`)
}

function option(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

try {
  if (command === "mcp") {
    await import("./dirac-edit-core-mcp.mjs")
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
