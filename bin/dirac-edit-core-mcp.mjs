#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { WorkspaceTools } from "../src/fs-tools.js"

const workspace = new WorkspaceTools({ cwd: process.env.DIRAC_EDIT_CORE_CWD || process.cwd() })
const server = new McpServer({ name: "dirac-edit-core", version: "0.1.0" })

const editSchema = z.object({
  type: z.enum(["replace", "insert_after", "insert_before"]).optional(),
  edit_type: z.enum(["replace", "insert_after", "insert_before"]).optional(),
  anchor: z.string().describe("Required full Anchor§line reference copied exactly from anchored_read or anchored_search, for example Aabc123§const x = 1."),
  endAnchor: z.string().optional().describe("Required for replace. Full Anchor§line reference for the final replaced line; for one-line replace, repeat anchor exactly."),
  end_anchor: z.string().optional().describe("Snake-case alias for endAnchor. Required for replace if endAnchor is omitted."),
  text: z.string().default("").describe("Replacement or inserted text without Anchor§ prefixes. Anchors are stripped if accidentally included."),
})

server.registerTool(
  "anchored_read",
  {
    title: "Anchored Read",
    description: "Read a workspace file with stable opaque line anchors for later anchored_edit calls. Copy the complete Anchor§line reference exactly, including the § delimiter and line text.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      sessionId: z.string().optional().describe("Optional anchor session id; use the same id for subsequent edits."),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
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
    description: "Search one workspace file and return compact anchored snippets. Use this before anchored_edit when you only need matching lines instead of a full anchored_read.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path to search."),
      query: z.string().describe("Literal search text by default, or a JavaScript regex pattern when regex is true."),
      sessionId: z.string().optional().describe("Optional anchor session id; use the same id for subsequent edits."),
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
    description: "Return a compact anchored outline of imports, classes, functions, and top-level declarations. Use before anchored_read when you need file structure without full file content.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      sessionId: z.string().optional().describe("Optional anchor session id; use the same id for subsequent get_function or edits."),
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
    description: "Return the anchored source range for a named function, class, type, or top-level declaration. Use this before anchored_edit when changing one symbol.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      name: z.string().describe("Symbol name to extract."),
      sessionId: z.string().optional().describe("Optional anchor session id; use the same id for subsequent edits."),
      contextLines: z.number().int().min(0).max(50).optional().describe("Context lines before and after the symbol. Default 0."),
      maxLines: z.number().int().positive().max(2000).optional().describe("Maximum anchored lines to return. Default 400."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await workspace.getFunction(args)
    return { content: [{ type: "text", text: result.text }], structuredContent: result, isError: result.found === false }
  },
)


server.registerTool(
  "symbol_replace",
  {
    title: "Symbol Replace",
    description: "Safely replace text only inside one named function/class/type/top-level declaration. Use for small symbol-scoped changes when full anchored_edit is unnecessary.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      name: z.string().describe("Symbol name whose body/range should be edited."),
      search: z.string().describe("Literal text to replace by default, or JavaScript regex pattern when regex is true."),
      replacement: z.string().default("").describe("Replacement text."),
      sessionId: z.string().optional().describe("Optional anchor session id."),
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
    description: "Apply exact anchor-targeted file edits atomically. First call anchored_read or anchored_search. For every edit, anchor must be the complete Anchor§line string. For replace, endAnchor is required; repeat anchor for a one-line replace. If this fails, retry with the exact expected Anchor§line shown in the error.",
    inputSchema: {
      path: z.string().describe("Workspace-relative file path."),
      sessionId: z.string().optional().describe("Anchor session id used for anchored_read."),
      edits: z.array(editSchema).min(1),
      atomic: z.boolean().optional().describe("Abort entire batch if any edit fails. Default true."),
      dryRun: z.boolean().optional().describe("Validate and preview without writing. Default false."),
    },
  },
  async (args) => {
    const result = await workspace.edit(args)
    const summary = result.ok
      ? `${result.dryRun ? "Would apply" : "Applied"} ${result.applied.length} anchored edit(s) to ${result.path}. ${result.beforeHash} -> ${result.afterHash}`
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
    description: "Apply exact anchor-targeted edits across multiple files. Validates every file before writing any file when atomic is true.",
    inputSchema: {
      sessionId: z.string().optional().describe("Default anchor session id used for files without their own sessionId."),
      files: z.array(z.object({
        path: z.string(),
        sessionId: z.string().optional(),
        edits: z.array(editSchema).min(1),
      })).min(1),
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
    description: "Report server workspace and tool status.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [{ type: "text", text: `dirac-edit-core MCP ready in ${workspace.cwd}` }],
    structuredContent: { cwd: workspace.cwd, version: "0.1.0" },
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
