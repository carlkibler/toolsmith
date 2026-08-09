#!/usr/bin/env node
import readline from "node:readline"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { WorkspaceTools } from "../src/fs-tools.js"
import { UsageLogger } from "../src/usage-log.js"
import { estimateTokens, makeCompressionReceipt } from "../src/telemetry.js"

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

// Update awareness, once at startup. stderr ONLY — stdout is the JSON-RPC channel. Cache-only
// read (instant), plus a detached daily refresh. Wrapped so it can never break the handshake.
try {
  const { cachedUpdateStatus, maybeScheduleRefresh, updateNoticeText } = await import("../lib/update-check.js")
  if (cachedUpdateStatus(version)?.behind) {
    const { installContext } = await import("../lib/config.js")
    const notice = updateNoticeText(version, { kind: installContext().kind })
    if (notice) process.stderr.write(`toolsmith MCP: ${notice}\n`)
  }
  maybeScheduleRefresh()
} catch { /* never block server startup on update awareness */ }

function verboseOutput() {
  return resultMode() === "verbose"
}

function compactToolsEnabled() {
  return envEnabled(process.env.TOOLSMITH_COMPACT_TOOLS)
}

function resultMode() {
  if (envEnabled(process.env.TOOLSMITH_VERBOSE) || envEnabled(process.env.TOOLSMITH_DEBUG)) return "verbose"
  const value = String(process.env.TOOLSMITH_MCP_RESULT_MODE || "compact").toLowerCase()
  if (["compact", "summary", "verbose"].includes(value)) return value
  return "compact"
}

function envEnabled(value) {
  return /^(1|true|yes|on|debug|verbose)$/i.test(String(value || ""))
}

function mcpToolResult(result, summary, { isError = false, nextAction } = {}) {
  const mode = resultMode()
  const body = result?.text || summary
  const text = nextAction && !isError ? `${body}\n\nNext: ${nextAction}` : body
  const enrichedResult = nextAction && !isError ? { ...result, nextAction } : result
  if (mode === "summary") {
    const saved = result?.telemetry?.estimatedTokensAvoided
    const summaryText = saved > 0 ? `${summary} (saved ~${Math.round(saved)} tokens)` : summary
    const promptedSummary = nextAction && !isError ? `${summaryText} Next: ${nextAction}` : summaryText
    return { content: [{ type: "text", text: promptedSummary }], structuredContent: enrichedResult, isError }
  }

  const structuredContent = mode === "compact" ? compactStructuredResult(enrichedResult, { text }) : { ...enrichedResult, text }
  return { content: [{ type: "text", text }], structuredContent, isError }
}

function compactStructuredResult(result, { text = "" } = {}) {
  const compact = stripLargePayloadFields(result)
  // Mirror the delivered body into structuredContent.text. Clients that render
  // structuredContent instead of content[] (e.g. Claude Code >=2.1.x) must still
  // see the anchored body; MCP requires structuredContent be functionally
  // equivalent to content. Nested duplicate arrays stay stripped for token savings.
  compact.text = text
  compact.compression = mcpCompressionReceipt({ original: result, compact, deliveredText: text })
  if (compact.telemetry && typeof compact.telemetry === "object") {
    compact.telemetry = { ...compact.telemetry, mcpCompression: compact.compression }
  }
  return compact
}

function mcpCompressionReceipt({ original, compact, deliveredText }) {
  const legacyPayload = JSON.stringify(original || {})
  const compactPayload = JSON.stringify({ content: [{ type: "text", text: deliveredText || "" }], structuredContent: compact || {} })
  return makeCompressionReceipt({
    strategy: "lossless_mcp_result_trim",
    originalTokens: estimateTokens(legacyPayload),
    compressedTokens: estimateTokens(compactPayload),
  })
}

function adapterResult(result, text = "") {
  return compactStructuredResult(result, { text })
}

function stripLargePayloadFields(value) {
  if (Array.isArray(value)) return value.map((item) => stripLargePayloadFields(item))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["content", "anchors", "anchor", "text", "snippet"].includes(key))
      .map(([key, item]) => [key, stripLargePayloadFields(item)]),
  )
}

function visibleTools() {
  return compactToolsEnabled() ? tools.filter((tool) => tool.name === "toolsmith") : tools.filter((tool) => tool.name !== "toolsmith")
}

function readSummary(result) {
  const lineCount = result.lineCount ?? result.endLine
  const isFullFile = result.startLine === 1 && result.endLine === lineCount
  const range = lineCount === 0
    ? "0 line(s)"
    : isFullFile
      ? `${lineCount} line(s)`
      : `lines ${result.startLine}–${result.endLine} of ${lineCount}`
  return `Anchored read ${result.path} (${range}; ${result.anchors?.length || 0} anchor(s)).`
}

function searchSummary(result) {
  if (result.error) return `Anchored search ${result.path} failed for ${JSON.stringify(result.query)}: ${result.error}`
  return `Anchored search ${result.path}: ${result.matches?.length || 0}${result.truncated ? "+" : ""} match(es) for ${JSON.stringify(result.query)}.`
}

function findSummary(result) {
  if (result.error) return `Find and anchor failed for ${JSON.stringify(result.query)} after scanning ${result.scannedFiles || 0} file(s): ${result.error}`
  return `Find and anchor: ${result.matches?.length || 0}${result.truncated ? "+" : ""} match(es) in ${result.matchedFiles || 0} file(s) for ${JSON.stringify(result.query)} (scanned ${result.scannedFiles || 0}).`
}

function skeletonSummary(result) {
  return `File skeleton ${result.path}: ${result.entries?.length || 0} entr${result.entries?.length === 1 ? "y" : "ies"}.`
}

function functionSummary(result) {
  return result.found
    ? `Function ${result.name} in ${result.path}: lines ${result.startLine}–${result.endLine}${result.truncated ? "+" : ""}.`
    : `Function ${result.name} not found in ${result.path}.`
}
if (process.env.TOOLSMITH_USAGE_LOG === "0" && verboseOutput()) process.stderr.write("[toolsmith-mcp] usage logging disabled (TOOLSMITH_USAGE_LOG=0)\n")

// Minimal MCP stdio server — newline-delimited JSON-RPC 2.0

const tools = []

function registerTool(name, meta, handler) {
  tools.push({ name, meta, handler: logged(name, handler), rawHandler: handler })
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
        const listedTools = visibleTools()
        await usageLogger.toolsList({ toolCount: listedTools.length })
        return { jsonrpc: "2.0", id, result: { tools: listedTools.map(({ name, meta }) => ({ name, title: meta.title, description: meta.description, inputSchema: meta.inputSchema, annotations: meta.annotations })) } }
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
    description: "Large file (>200 lines): default broad or editable read. Returns stable line references; next step is anchored_edit with the same sessionId. Use startLine/endLine to limit transfer. Anchor before alteration.",
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
    return mcpToolResult(result, readSummary(result), { nextAction: "use anchored_edit with these anchors and the same sessionId if you need to change this file." })
  },
)

registerTool(
  "anchored_search",
  {
    title: "Anchored Search",
    description: "Search one file when you intend to edit: returns anchored snippets ready for anchored_edit with no separate read. Prefer over grep on files >200 lines. Anchor before alteration.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path to search." },
        query: { type: "string", description: "Literal search text by default, or a JavaScript regex pattern when regex is true." },
        sessionId: { type: "string", maxLength: 256, description: "Optional anchor session id; use the same id for subsequent edits." },
        regex: { type: "boolean", description: "Treat query as a JavaScript regular expression. Default false." },
        caseSensitive: { type: "boolean", description: "Case-sensitive matching. Default false." },
        contextLines: { type: "integer", minimum: 0, description: "Context lines before and after each match. Default 1; capped at 50 (higher values are clamped, not rejected)." },
        maxMatches: { type: "integer", minimum: 1, description: "Maximum matches to return. Default 20; capped at 200 (clamped)." },
      },
      required: ["path", "query"],
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.search(args)
    return mcpToolResult(result, searchSummary(result), { isError: Boolean(result.error), nextAction: result.matches?.length ? "use anchored_edit with a returned anchor and the same sessionId." : "adjust the query; no editable anchor was returned." })
  },
)

registerTool(
  "find_and_anchor",
  {
    title: "Find and Anchor",
    description: "Large or unfamiliar codebase: default search before editing. Returns anchored snippets ready for anchored_edit; prefer over rg+sed/cat. Directory searches rank candidates by BM25 and honor .toolsmithignore. Anchor before alteration.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file or directory to search. Default '.'." },
        query: { type: "string", description: "Literal search text by default, or a JavaScript regex pattern when regex is true." },
        sessionId: { type: "string", maxLength: 256, description: "Optional anchor session id; use the same id for subsequent edits." },
        glob: { type: "string", description: "Optional glob filter, e.g. 'src/**/*.js' or '*.md'. Comma/space-separated patterns allowed." },
        regex: { type: "boolean", description: "Treat query as a JavaScript regex. Default false." },
        caseSensitive: { type: "boolean", description: "Case-sensitive matching. Default false." },
        contextLines: { type: "integer", minimum: 0, description: "Context lines before and after each match. Default 2; capped at 50 (higher values are clamped, not rejected)." },
        maxMatches: { type: "integer", minimum: 1, description: "Maximum matches to return across all files. Default 20; capped at 200 (clamped)." },
        maxFiles: { type: "integer", minimum: 1, description: "Maximum candidate files to scan. Default 80; capped at 1000 (clamped)." },
        maxMatchesPerFile: { type: "integer", minimum: 1, description: "Maximum matches to return from one file during directory search. Default 5; capped at 50 (clamped)." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.findAndAnchor(args)
    return mcpToolResult(result, findSummary(result), { isError: Boolean(result.error), nextAction: result.matches?.length ? "use anchored_edit on the chosen match with the same sessionId." : "adjust the query or glob; no editable anchor was returned." })
  },
)


registerTool(
  "file_skeleton",
  {
    title: "File Skeleton",
    description: "Large file (>200 lines): default first read. Returns declarations at ~10% of full-file token cost. Next choose get_function, find_and_anchor, or bounded anchored_read instead of reading the whole file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        sessionId: { type: "string", maxLength: 256, description: "Optional anchor session id; use the same id for subsequent get_function or edits." },
        maxLines: { type: "integer", minimum: 1, description: "Maximum skeleton entries to return. Default 200; capped at 1000 (clamped)." },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.skeleton(args)
    return mcpToolResult(result, skeletonSummary(result), { nextAction: "choose get_function for one symbol, find_and_anchor for a target, or bounded anchored_read for a range." })
  },
)

registerTool(
  "get_function",
  {
    title: "Get Function",
    description: "Known symbol in a large file: default read. Returns only that function, class, or method with anchors; next use anchored_edit with the same sessionId, or symbol_replace when no pre-read is needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        name: { type: "string", description: "Symbol name to extract." },
        sessionId: { type: "string", maxLength: 256, description: "Optional anchor session id; use the same id for subsequent edits." },
        contextLines: { type: "integer", minimum: 0, description: "Context lines before and after the symbol. Default 0; capped at 50 (higher values are clamped, not rejected)." },
        maxLines: { type: "integer", minimum: 1, description: "Maximum anchored lines to return. Default 400; capped at 2000 (clamped)." },
      },
      required: ["path", "name"],
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.getFunction(args)
    return mcpToolResult(result, functionSummary(result), { isError: false, nextAction: result.found ? "use anchored_edit with these anchors and the same sessionId." : "use file_skeleton or find_and_anchor to locate the current symbol." })
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
      ? `${result.dryRun ? "Would replace" : "Replaced"} ${result.matches} match(es) in ${result.name} (${result.path}).`
      : result.notFound
        ? `No match in ${args.path}: ${result.errors.join("; ")} — try get_function to inspect the current source.`
        : `Symbol replace failed for ${args.path}:\n${result.errors.join("\n")}`
    return { content: [{ type: "text", text: summary }], structuredContent: adapterResult(result, summary), isError: !result.ok && !result.notFound }
  },
)

registerTool(
  "anchored_edit",
  {
    title: "Anchored Edit",
    description: "Large file (>200 lines): default edit after anchored_read, anchored_search, find_and_anchor, or get_function. Validates the current file before writing. Use the same sessionId and copy full line references exactly. Anchor before alteration.",
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
    if (envEnabled(process.env.TOOLSMITH_DEBUG)) for (const w of warningLines) process.stderr.write(`[toolsmith-mcp] ${w}\n`)
    const summary = result.ok
      ? `${result.dryRun ? "Would apply" : "Applied"} ${result.applied.length} anchored edit(s) to ${result.path}${result.changed ? "" : " (no content change)"}.${warningLines.length ? `\n${warningLines.join("\n")}` : ""}`
      : `Anchored edit failed for ${result.path}:\n${result.errors.join("\n")}`
    return { content: [{ type: "text", text: summary }], structuredContent: adapterResult(result, summary), isError: !result.ok }
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
    if (envEnabled(process.env.TOOLSMITH_DEBUG)) for (const w of warningLines) process.stderr.write(`[toolsmith-mcp] ${w}\n`)
    const edited = result.files.reduce((sum, file) => sum + (file.applied?.length || 0), 0)
    const summary = result.ok
      ? `${result.dryRun ? "Would apply" : "Applied"} ${edited} anchored edit(s) across ${result.files.length} file(s).${warningLines.length ? `\n${warningLines.join("\n")}` : ""}`
      : `Multi-file anchored edit failed:\n${result.errors.join("\n")}`
    return { content: [{ type: "text", text: summary }], structuredContent: adapterResult(result, summary), isError: !result.ok }
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


const ROUTER_ACTIONS = {
  read: "anchored_read",
  search: "anchored_search",
  find: "find_and_anchor",
  skeleton: "file_skeleton",
  function: "get_function",
  get_function: "get_function",
  symbol_replace: "symbol_replace",
  edit: "anchored_edit",
  edit_many: "anchored_edit_many",
  status: "anchored_edit_status",
}

registerTool(
  "toolsmith",
  {
    title: "Toolsmith Router",
    description: "Compact tool surface for Toolsmith. Set TOOLSMITH_COMPACT_TOOLS=1 to expose only this router. Pass tool as anchored_read, anchored_search, find_and_anchor, file_skeleton, get_function, symbol_replace, anchored_edit, anchored_edit_many, or anchored_edit_status, with arguments containing that tool's normal input.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Target Toolsmith tool name, e.g. file_skeleton or anchored_edit." },
        action: { type: "string", description: "Short alias: read, search, find, skeleton, get_function, symbol_replace, edit, edit_many, or status." },
        arguments: { type: "object", description: "Arguments for the target tool." },
        args: { type: "object", description: "Alias for arguments." },
      },
    },
  },
  async (args) => {
    const requested = args.tool || args.name || ROUTER_ACTIONS[String(args.action || "").toLowerCase()]
    const targetName = ROUTER_ACTIONS[String(requested || "").toLowerCase()] || requested
    if (!targetName || targetName === "toolsmith") throw new Error("toolsmith router requires a target tool or action")
    const target = tools.find((tool) => tool.name === targetName && tool.name !== "toolsmith")
    if (!target) throw new Error(`unknown Toolsmith target: ${targetName}`)
    const toolArgs = args.arguments || args.args || Object.fromEntries(Object.entries(args).filter(([key]) => !["tool", "name", "action", "arguments", "args"].includes(key)))
    return target.rawHandler(toolArgs || {})
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
