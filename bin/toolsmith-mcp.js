#!/usr/bin/env node
import readline from "node:readline"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { WorkspaceTools } from "../src/fs-tools.js"
import { UsageLogger } from "../src/usage-log.js"

{
  const major = Number(process.versions.node.split(".")[0])
  if (major < 20) {
    process.stderr.write(`toolsmith requires Node 20+; current: ${process.versions.node}\nTry: nvm install 20 && nvm use 20\n`)
    process.exit(64)
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"))

const workspace = new WorkspaceTools({ cwd: process.env.TOOLSMITH_CWD || process.cwd() })
const usageLogger = new UsageLogger({ cwd: workspace.cwd, version })

function verboseOutput() {
  return envEnabled(process.env.TOOLSMITH_VERBOSE) || envEnabled(process.env.TOOLSMITH_DEBUG)
}

function envEnabled(value) {
  return /^(1|true|yes|on|debug|verbose)$/i.test(String(value || ""))
}

function toolContent(result, summary) {
  return [{ type: "text", text: verboseOutput() ? result.text : summary }]
}

function readSummary(result) {
  const lineCount = result.lineCount || result.endLine
  const range = result.startLine === 1 && result.endLine === lineCount
    ? `${lineCount} line(s)`
    : `lines ${result.startLine}–${result.endLine} of ${lineCount}`
  return `Anchored read ${result.path} (${range}, ${result.anchors?.length || 0} anchor(s), hash ${result.fileHash}). Full anchored content is in structuredContent.text.`
}

function searchSummary(result) {
  return `Anchored search ${result.path} matched ${result.matches?.length || 0} line(s) for ${JSON.stringify(result.query)} (hash ${result.fileHash}). Full anchored snippets are in structuredContent.text.`
}

function findSummary(result) {
  return `Find and anchor scanned ${result.scannedFiles || 0} file(s), matched ${result.matches?.length || 0} line(s) in ${result.matchedFiles || 0} file(s) for ${JSON.stringify(result.query)}. Full anchored snippets are in structuredContent.text.`
}

function skeletonSummary(result) {
  return `File skeleton ${result.path}: ${result.entries?.length || 0} entr${result.entries?.length === 1 ? "y" : "ies"} (hash ${result.fileHash}). Full anchored skeleton is in structuredContent.text.`
}

function functionSummary(result) {
  return result.found
    ? `Function ${result.name} in ${result.path}: lines ${result.startLine}–${result.endLine}${result.truncated ? "+" : ""} (hash ${result.fileHash}). Full anchored source is in structuredContent.text.`
    : `Function ${result.name} not found in ${result.path} (hash ${result.fileHash}).`
}
if (process.env.TOOLSMITH_USAGE_LOG === "0" && verboseOutput()) process.stderr.write("[toolsmith-mcp] usage logging disabled (TOOLSMITH_USAGE_LOG=0)\n")

// Minimal MCP stdio server — newline-delimited JSON-RPC 2.0

const tools = []

function registerTool(name, meta, handler) {
  tools.push({ name, meta, handler: logged(name, handler) })
}

function logged(name, handler) {
  return async (args) => {
    const started = Date.now()
    try {
      const result = await handler(args)
      await usageLogger.toolCall({ tool: name, args, result, durationMs: Date.now() - started })
      return result
    } catch (error) {
      await usageLogger.toolCall({ tool: name, args, error, errorStack: error?.stack, durationMs: Date.now() - started })
      throw error
    }
  }
}

async function dispatch(msg) {
  const { id, method, params } = msg
  switch (method) {
    case "initialize": {
      const clientName = params?.clientInfo?.name
      if (clientName) usageLogger.setClient(clientName)
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "toolsmith", version } } }
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} }
    case "tools/list":
      try {
        await usageLogger.toolsList({ toolCount: tools.length })
        return { jsonrpc: "2.0", id, result: { tools: tools.map(({ name, meta }) => ({ name, title: meta.title, description: meta.description, inputSchema: meta.inputSchema, annotations: meta.annotations })) } }
      } catch (e) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: e?.message ?? String(e) } }
      }
    case "tools/call": {
      const tool = tools.find((t) => t.name === params?.name)
      if (!tool) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Tool not found: ${params?.name}` } }
      try {
        return { jsonrpc: "2.0", id, result: await tool.handler(params?.arguments ?? {}) }
      } catch (e) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: e?.message ?? String(e) } }
      }
    }
    default:
      return id !== undefined ? { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } } : null
  }
}

// Tool schemas (plain JSON Schema)

const MAX_TEXT_BYTES = 512 * 1024

const editSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["replace", "insert_after", "insert_before"] },
    edit_type: { type: "string", enum: ["replace", "insert_after", "insert_before"] },
    anchor: { type: "string", description: "Required full Anchor§line reference copied exactly from anchored_read or anchored_search, for example Aabc123§const x = 1." },
    endAnchor: { type: "string", description: "Required for replace. Full Anchor§line reference for the final replaced line; for one-line replace, repeat anchor exactly." },
    end_anchor: { type: "string", description: "Snake-case alias for endAnchor. Required for replace if endAnchor is omitted." },
    text: { type: "string", maxLength: MAX_TEXT_BYTES, default: "", description: "Replacement or inserted text without Anchor§ prefixes. Anchors are stripped if accidentally included." },
  },
  required: ["anchor"],
}

registerTool(
  "anchored_read",
  {
    title: "Anchored Read",
    description: "Prefer over native Read for files >200 lines — reads only the requested range and returns stable Anchor§line references for anchored_edit. Use startLine/endLine to limit transfer. Copy anchors exactly.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        sessionId: { type: "string", maxLength: 256, description: "Anchor session id — use the same value for all reads and edits in a task. Recommended: your task name or a short identifier. Default: 'default'." },
        startLine: { type: "integer", minimum: 1, description: "First line to return (1-based). Omit to read from the beginning." },
        endLine: { type: "integer", minimum: 1, description: "Last line to return (1-based, inclusive). Omit to read to end of file." },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.read(args)
    return { content: toolContent(result, readSummary(result)), structuredContent: result }
  },
)

registerTool(
  "anchored_search",
  {
    title: "Anchored Search",
    description: "Use instead of grep when you'll edit results — returns anchored snippets ready for anchored_edit without a separate read.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path to search." },
        query: { type: "string", description: "Literal search text by default, or a JavaScript regex pattern when regex is true." },
        sessionId: { type: "string", maxLength: 256, description: "Optional anchor session id; use the same id for subsequent edits." },
        regex: { type: "boolean", description: "Treat query as a JavaScript regular expression. Default false." },
        caseSensitive: { type: "boolean", description: "Case-sensitive matching. Default false." },
        contextLines: { type: "integer", minimum: 0, maximum: 20, description: "Context lines before and after each match. Default 1." },
        maxMatches: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches to return. Default 20." },
      },
      required: ["path", "query"],
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.search(args)
    return { content: toolContent(result, searchSummary(result)), structuredContent: result }
  },
)

registerTool(
  "find_and_anchor",
  {
    title: "Find and Anchor",
    description: "Repo/file search that returns anchored snippets ready for anchored_edit. Use instead of rg+sed/cat when searching large or unfamiliar files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file or directory to search. Default '.'." },
        query: { type: "string", description: "Literal search text by default, or a JavaScript regex pattern when regex is true." },
        sessionId: { type: "string", maxLength: 256, description: "Optional anchor session id; use the same id for subsequent edits." },
        glob: { type: "string", description: "Optional glob filter, e.g. 'src/**/*.js' or '*.md'. Comma/space-separated patterns allowed." },
        regex: { type: "boolean", description: "Treat query as a JavaScript regex. Default false." },
        caseSensitive: { type: "boolean", description: "Case-sensitive matching. Default false." },
        contextLines: { type: "integer", minimum: 0, maximum: 20, description: "Context lines before and after each match. Default 2." },
        maxMatches: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches to return across all files. Default 20." },
        maxFiles: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum candidate files to scan. Default 80." },
        maxMatchesPerFile: { type: "integer", minimum: 1, maximum: 50, description: "Maximum matches to return from one file during directory search. Default 5." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.findAndAnchor(args)
    return { content: toolContent(result, findSummary(result)), structuredContent: result }
  },
)


registerTool(
  "file_skeleton",
  {
    title: "File Skeleton",
    description: "Use instead of native Read to explore large or unfamiliar files — returns only declarations (functions, classes, constants) at ~10% of full-file token cost. Orient here before get_function or anchored_read.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        sessionId: { type: "string", maxLength: 256, description: "Optional anchor session id; use the same id for subsequent get_function or edits." },
        maxLines: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum skeleton entries to return. Default 200." },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.skeleton(args)
    return { content: toolContent(result, skeletonSummary(result)), structuredContent: result }
  },
)

registerTool(
  "get_function",
  {
    title: "Get Function",
    description: "Prefer over native Read when the target symbol is known — returns only that function, class, or method's anchored source without reading the whole file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        name: { type: "string", description: "Symbol name to extract." },
        sessionId: { type: "string", maxLength: 256, description: "Optional anchor session id; use the same id for subsequent edits." },
        contextLines: { type: "integer", minimum: 0, maximum: 50, description: "Context lines before and after the symbol. Default 0." },
        maxLines: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum anchored lines to return. Default 400." },
      },
      required: ["path", "name"],
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.getFunction(args)
    return { content: toolContent(result, functionSummary(result)), structuredContent: result, isError: false }
  },
)

registerTool(
  "symbol_replace",
  {
    title: "Symbol Replace",
    description: "Default for single-symbol edits — change code inside a named function, class, or method with no pre-read required. Use anchored_edit for multi-symbol or multi-line changes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        name: { type: "string", description: "Symbol name whose body/range should be edited." },
        search: { type: "string", description: "Literal text to replace by default, or JavaScript regex pattern when regex is true." },
        replacement: { type: "string", default: "", description: "Replacement text." },
        sessionId: { type: "string", maxLength: 256, description: "Optional anchor session id." },
        regex: { type: "boolean", description: "Treat search as a JavaScript regex. Default false." },
        replaceAll: { type: "boolean", description: "Replace every match inside the symbol. Default false." },
        caseSensitive: { type: "boolean", description: "Case-sensitive matching. Default true." },
        dryRun: { type: "boolean", description: "Validate and preview without writing. Default false." },
      },
      required: ["path", "name", "search"],
    },
  },
  async (args) => {
    const result = await workspace.symbolReplace(args)
    const summary = result.ok
      ? `${result.dryRun ? "Would replace" : "Replaced"} ${result.matches} match(es) in ${result.name} (${result.path}). ${result.beforeHash} -> ${result.afterHash}`
      : result.notFound
        ? `No match in ${args.path}: ${result.errors.join("; ")} — try get_function to inspect the current source.`
        : `Symbol replace failed for ${args.path}:\n${result.errors.join("\n")}`
    return { content: [{ type: "text", text: summary }], structuredContent: result, isError: !result.ok && !result.notFound }
  },
)

registerTool(
  "anchored_edit",
  {
    title: "Anchored Edit",
    description: "Prefer over native Edit for files >200 lines — validates anchor content matches current file before writing, preventing silent overwrites when files change between read and edit. Prereq: anchored_read, anchored_search, or get_function. anchor must be full Anchor§line string; endAnchor required for replace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        sessionId: { type: "string", maxLength: 256, description: "Anchor session id used for anchored_read." },
        workspace: { type: "string", maxLength: 256, description: "Optional workspace identifier the anchors were issued under (matches the [Workspace: …] tag in anchored_read output). Mismatch warns in 0.1.x; will be rejected in 0.2.x." },
        edits: { type: "array", items: editSchema, minItems: 1, maxItems: 100 },
        atomic: { type: "boolean", description: "Abort entire batch if any edit fails. Default true." },
        dryRun: { type: "boolean", description: "Validate and preview without writing. Default false." },
      },
      required: ["path", "edits"],
    },
  },
  async (args) => {
    const result = await workspace.edit(args)
    const warningLines = (result.warnings || []).map((w) => `warning: ${w}`)
    for (const w of warningLines) process.stderr.write(`[toolsmith-mcp] ${w}\n`)
    const summary = result.ok
      ? `${result.dryRun ? "Would apply" : "Applied"} ${result.applied.length} anchored edit(s) to ${result.path}${result.changed ? "" : " (no content change)"}. ${result.beforeHash} -> ${result.afterHash}${warningLines.length ? `\n${warningLines.join("\n")}` : ""}`
      : `Anchored edit failed for ${result.path}:\n${result.errors.join("\n")}`
    return { content: [{ type: "text", text: summary }], structuredContent: result, isError: !result.ok }
  },
)

registerTool(
  "anchored_edit_many",
  {
    title: "Anchored Edit Many",
    description: "Use instead of multiple anchored_edit calls when changing more than one file — validates all files before writing any.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", maxLength: 256, description: "Default anchor session id used for files without their own sessionId." },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              sessionId: { type: "string", maxLength: 256 },
              edits: { type: "array", items: editSchema, minItems: 1, maxItems: 100 },
            },
            required: ["path", "edits"],
          },
        },
        workspace: { type: "string", maxLength: 256, description: "Optional workspace identifier the anchors were issued under (matches the [Workspace: …] tag in anchored_read output). Mismatch warns in 0.1.x; will be rejected in 0.2.x." },
        atomic: { type: "boolean", description: "Abort entire multi-file batch if any edit fails. Default true." },
        dryRun: { type: "boolean", description: "Validate and preview without writing. Default false." },
      },
      required: ["files"],
    },
  },
  async (args) => {
    const result = await workspace.editMany(args)
    const warningLines = (result.warnings || []).map((w) => `warning: ${w}`)
    for (const w of warningLines) process.stderr.write(`[toolsmith-mcp] ${w}\n`)
    const edited = result.files.reduce((sum, file) => sum + (file.applied?.length || 0), 0)
    const summary = result.ok
      ? `${result.dryRun ? "Would apply" : "Applied"} ${edited} anchored edit(s) across ${result.files.length} file(s).${warningLines.length ? `\n${warningLines.join("\n")}` : ""}`
      : `Multi-file anchored edit failed:\n${result.errors.join("\n")}`
    return { content: [{ type: "text", text: summary }], structuredContent: result, isError: !result.ok }
  },
)

registerTool(
  "anchored_edit_status",
  {
    title: "Anchored Edit Status",
    description: "Check active anchors and session state. Use at task start or to diagnose anchor failures.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  async () => {
    const files = workspace.store.summary()
    const storeText = files.length === 0
      ? "(no files in anchor store)"
      : `${files.length} file(s) in anchor store:\n${files.map((f) => `  ${f.path} [session: ${f.sessionId}, lines: ${f.lineCount}]`).join("\n")}`
    return {
      content: [{ type: "text", text: `toolsmith MCP ready in ${workspace.cwd} [workspace: ${workspace.workspaceKey}]\n${storeText}` }],
      structuredContent: { cwd: workspace.cwd, workspaceKey: workspace.workspaceKey, version, files },
    }
  },
)

// Process lifetime guards — keep the server alive past individual request errors.
process.on("uncaughtException", (err) => {
  process.stderr.write(`[toolsmith-mcp] uncaughtException: ${err?.message ?? err}\n`)
})
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[toolsmith-mcp] unhandledRejection: ${reason?.message ?? reason}\n`)
})
// Ignore SIGPIPE so a parent disconnect mid-write doesn't crash the server.
process.on("SIGPIPE", () => {})

// Start
await usageLogger.startup()
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on("line", async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  try {
    const response = await dispatch(msg)
    if (response !== null) process.stdout.write(JSON.stringify(response) + "\n")
  } catch (e) {
    process.stderr.write(`[toolsmith-mcp] dispatch error: ${e?.message ?? e}\n`)
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e?.message ?? String(e) } }) + "\n")
    }
  }
})
