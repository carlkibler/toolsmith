#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { WorkspaceTools } from "../src/fs-tools.js"

const workspace = new WorkspaceTools({ cwd: process.env.TOOLSMITH_CWD || process.cwd() })
const server = new McpServer({ name: "toolsmith", version: "0.1.0" })

const MAX_TEXT_BYTES = 512 * 1024

const editSchema = z.object({
  type: z.enum(["replace", "insert_after", "insert_before"]).optional(),
  edit_type: z.enum(["replace", "insert_after", "insert_before"]).optional(),
  anchor: z.string().describe("Required full Anchor§line reference copied exactly from anchored_read or anchored_search, for example Aabc123§const x = 1."),
  endAnchor: z.string().optional().describe("Required for replace. Full Anchor§line reference for the final replaced line; for one-line replace, repeat anchor exactly."),
  end_anchor: z.string().optional().describe("Snake-case alias for endAnchor. Required for replace if endAnchor is omitted."),
  text: z.string().max(MAX_TEXT_BYTES).default("").describe("Replacement or inserted text without Anchor§ prefixes. Anchors are stripped if accidentally included."),
})

server.registerTool(
  "anchored_read",
  {
    title: "Anchored Read",
    description: "Use when editing or reading files >200 lines. Returns stable line anchors (Anchor§line) for anchored_edit — avoids re-reading on every change. Use startLine/endLine for partial reads on large files. Copy Anchor§line references exactly.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      sessionId: z.string().max(256).optional().describe("Anchor session id — use the same value for all reads and edits in a task. Recommended: your task name or a short identifier. Default: 'default'."),
      startLine: z.number().int().positive().optional().describe("First line to return (1-based). Omit to read from the beginning."),
      endLine: z.number().int().positive().optional().describe("Last line to return (1-based, inclusive). Omit to read to end of file."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.read(args)
    return {
      content: [{ type: "text", text: result.text }],
      structuredContent: result,
    }
  },
)

server.registerTool(
  "anchored_search",
  {
    title: "Anchored Search",
    description: "Use instead of grep when you'll edit results — returns anchored snippets ready for anchored_edit without a separate read.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path to search."),
      query: z.string().describe("Literal search text by default, or a JavaScript regex pattern when regex is true."),
      sessionId: z.string().max(256).optional().describe("Optional anchor session id; use the same id for subsequent edits."),
      regex: z.boolean().optional().describe("Treat query as a JavaScript regular expression. Default false."),
      caseSensitive: z.boolean().optional().describe("Case-sensitive matching. Default false."),
      contextLines: z.number().int().min(0).max(20).optional().describe("Context lines before and after each match. Default 1."),
      maxMatches: z.number().int().positive().max(200).optional().describe("Maximum matches to return. Default 20."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.search(args)
    return {
      content: [{ type: "text", text: result.text }],
      structuredContent: result,
    }
  },
)


server.registerTool(
  "file_skeleton",
  {
    title: "File Skeleton",
    description: "Use to explore unfamiliar files without reading them — returns an anchored outline of declarations at low token cost. Orient here, then get_function or anchored_read for details.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      sessionId: z.string().max(256).optional().describe("Optional anchor session id; use the same id for subsequent get_function or edits."),
      maxLines: z.number().int().positive().max(1000).optional().describe("Maximum skeleton entries to return. Default 200."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.skeleton(args)
    return { content: [{ type: "text", text: result.text }], structuredContent: result }
  },
)

server.registerTool(
  "get_function",
  {
    title: "Get Function",
    description: "Use when changing a known symbol — returns only that symbol's anchored source, not the whole file. Pass anchors directly to anchored_edit.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      name: z.string().describe("Symbol name to extract."),
      sessionId: z.string().max(256).optional().describe("Optional anchor session id; use the same id for subsequent edits."),
      contextLines: z.number().int().min(0).max(50).optional().describe("Context lines before and after the symbol. Default 0."),
      maxLines: z.number().int().positive().max(2000).optional().describe("Maximum anchored lines to return. Default 400."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.getFunction(args)
    return { content: [{ type: "text", text: result.text }], structuredContent: result, isError: false }
  },
)


server.registerTool(
  "symbol_replace",
  {
    title: "Symbol Replace",
    description: "Default for single-symbol edits — change code inside a named function, class, or method with no pre-read required. Use anchored_edit for multi-symbol or multi-line changes.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      name: z.string().describe("Symbol name whose body/range should be edited."),
      search: z.string().describe("Literal text to replace by default, or JavaScript regex pattern when regex is true."),
      replacement: z.string().default("").describe("Replacement text."),
      sessionId: z.string().max(256).optional().describe("Optional anchor session id."),
      regex: z.boolean().optional().describe("Treat search as a JavaScript regex. Default false."),
      replaceAll: z.boolean().optional().describe("Replace every match inside the symbol. Default false."),
      caseSensitive: z.boolean().optional().describe("Case-sensitive matching. Default true."),
      dryRun: z.boolean().optional().describe("Validate and preview without writing. Default false."),
    },
  },
  async (args) => {
    const result = await workspace.symbolReplace(args)
    const summary = result.ok
      ? `${result.dryRun ? "Would replace" : "Replaced"} ${result.matches} match(es) in ${result.name} (${result.path}). ${result.beforeHash} -> ${result.afterHash}`
      : `Symbol replace failed for ${args.path}:\n${result.errors.join("\n")}`
    return { content: [{ type: "text", text: summary }], structuredContent: result, isError: !result.ok }
  },
)

server.registerTool(
  "anchored_edit",
  {
    title: "Anchored Edit",
    description: "Lowest-token edit path for files >200 lines. Prereq: call anchored_read, anchored_search, or get_function first. anchor must be the full Anchor§line string; endAnchor required for replace (repeat anchor for single-line). On failure, retry with the exact Anchor§line from the error.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      sessionId: z.string().max(256).optional().describe("Anchor session id used for anchored_read."),
      edits: z.array(editSchema).min(1).max(100),
      atomic: z.boolean().optional().describe("Abort entire batch if any edit fails. Default true."),
      dryRun: z.boolean().optional().describe("Validate and preview without writing. Default false."),
    },
  },
  async (args) => {
    const result = await workspace.edit(args)
    const summary = result.ok
      ? `${result.dryRun ? "Would apply" : "Applied"} ${result.applied.length} anchored edit(s) to ${result.path}${result.changed ? "" : " (no content change)"}. ${result.beforeHash} -> ${result.afterHash}`
      : `Anchored edit failed for ${result.path}:\n${result.errors.join("\n")}`
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: result,
      isError: !result.ok,
    }
  },
)


server.registerTool(
  "anchored_edit_many",
  {
    title: "Anchored Edit Many",
    description: "Use instead of multiple anchored_edit calls when changing more than one file — validates all files before writing any.",
    inputSchema: {
      sessionId: z.string().max(256).optional().describe("Default anchor session id used for files without their own sessionId."),
      files: z.array(z.object({
        path: z.string(),
        sessionId: z.string().max(256).optional(),
        edits: z.array(editSchema).min(1).max(100),
      })).min(1).max(50),
      atomic: z.boolean().optional().describe("Abort entire multi-file batch if any edit fails. Default true."),
      dryRun: z.boolean().optional().describe("Validate and preview without writing. Default false."),
    },
  },
  async (args) => {
    const result = await workspace.editMany(args)
    const edited = result.files.reduce((sum, file) => sum + (file.applied?.length || 0), 0)
    const summary = result.ok
      ? `${result.dryRun ? "Would apply" : "Applied"} ${edited} anchored edit(s) across ${result.files.length} file(s).`
      : `Multi-file anchored edit failed:\n${result.errors.join("\n")}`
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: result,
      isError: !result.ok,
    }
  },
)

server.registerTool(
  "anchored_edit_status",
  {
    title: "Anchored Edit Status",
    description: "Check active anchors and session state. Use at task start or to diagnose anchor failures.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const files = workspace.store.summary()
    const storeText = files.length === 0
      ? "(no files in anchor store)"
      : `${files.length} file(s) in anchor store:\n${files.map((f) => `  ${f.path} [session: ${f.sessionId}, lines: ${f.lineCount}]`).join("\n")}`
    return {
      content: [{ type: "text", text: `toolsmith MCP ready in ${workspace.cwd}\n${storeText}` }],
      structuredContent: { cwd: workspace.cwd, version: "0.1.0", files },
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
