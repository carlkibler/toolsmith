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
  anchor: z.string(),
  endAnchor: z.string().optional(),
  end_anchor: z.string().optional(),
  text: z.string().default(""),
})

server.registerTool(
  "anchored_read",
  {
    title: "Anchored Read",
    description: "Read a workspace file with stable opaque line anchors for later anchored_edit calls.",
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
  "anchored_edit",
  {
    title: "Anchored Edit",
    description: "Apply exact anchor-targeted file edits atomically. Call anchored_read first and include full Anchor§line references.",
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
