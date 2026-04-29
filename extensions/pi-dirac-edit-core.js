import { Type } from "typebox"
import { WorkspaceTools } from "../src/fs-tools.js"

const workspaces = new Map()

function toolsFor(cwd) {
  const key = cwd || process.cwd()
  if (!workspaces.has(key)) workspaces.set(key, new WorkspaceTools({ cwd: key }))
  return workspaces.get(key)
}

const editSchema = Type.Object({
  type: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("insert_after"), Type.Literal("insert_before")])),
  edit_type: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("insert_after"), Type.Literal("insert_before")])),
  anchor: Type.String({ description: "Full Anchor§line reference from pi_anchored_read." }),
  endAnchor: Type.Optional(Type.String({ description: "Full Anchor§line reference for replace end." })),
  end_anchor: Type.Optional(Type.String({ description: "Snake-case alias for endAnchor." })),
  text: Type.String({ description: "Replacement or inserted text. Anchors are stripped if included." }),
})

export default function diracEditCorePiExtension(pi) {
  pi.registerTool({
    name: "pi_anchored_read",
    label: "anchored read",
    description: "Read a file with stable opaque line anchors for precise batched edits. Prefer this before pi_anchored_edit.",
    promptSnippet: "Read file content with stable line anchors for precise low-token edits",
    promptGuidelines: [
      "For multi-location edits, prefer pi_anchored_read followed by one batched pi_anchored_edit call.",
      "When using pi_anchored_edit, include the full Anchor§line content reference exactly as returned.",
    ],
    executionMode: "parallel",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path." }),
      sessionId: Type.Optional(Type.String({ description: "Anchor session id. Use same value for read/edit." })),
      startLine: Type.Optional(Type.Number({ minimum: 1 })),
      endLine: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx.cwd).read(params)
      return { content: [{ type: "text", text: result.text }], details: result }
    },
  })

  pi.registerTool({
    name: "pi_anchored_edit",
    label: "anchored edit",
    description: "Apply exact anchor-targeted edits atomically. Use full Anchor§line references from pi_anchored_read.",
    promptSnippet: "Apply exact batched edits by stable line anchors",
    promptGuidelines: [
      "Batch all non-overlapping edits to the same file into one pi_anchored_edit call.",
      "Use dryRun true when uncertain; stale anchors fail without modifying the file.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path." }),
      sessionId: Type.Optional(Type.String({ description: "Anchor session id used for pi_anchored_read." })),
      edits: Type.Array(editSchema, { minItems: 1 }),
      atomic: Type.Optional(Type.Boolean({ description: "Abort entire batch if any edit fails. Default true." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Validate and preview without writing. Default false." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx.cwd).edit(params)
      const text = result.ok
        ? `${result.dryRun ? "Would apply" : "Applied"} ${result.applied.length} anchored edit(s) to ${result.path}. ${result.beforeHash} -> ${result.afterHash}`
        : `Anchored edit failed for ${result.path}:\n${result.errors.join("\n")}`
      return { content: [{ type: "text", text }], details: result, isError: !result.ok }
    },
  })

  pi.registerTool({
    name: "pi_anchored_edit_many",
    label: "anchored edit many",
    description: "Apply exact anchor-targeted edits across multiple files. Validates every file before writing any file when atomic is true.",
    promptSnippet: "Apply exact batched edits across multiple files by stable line anchors",
    promptGuidelines: [
      "For cross-file refactors, prefer one pi_anchored_edit_many call after reading the target files.",
      "Use dryRun true when uncertain; atomic true prevents partial writes on stale anchors.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      sessionId: Type.Optional(Type.String({ description: "Default anchor session id used for files without their own sessionId." })),
      files: Type.Array(Type.Object({
        path: Type.String({ description: "Workspace-relative file path." }),
        sessionId: Type.Optional(Type.String({ description: "Optional per-file anchor session id." })),
        edits: Type.Array(editSchema, { minItems: 1 }),
      }), { minItems: 1 }),
      atomic: Type.Optional(Type.Boolean({ description: "Abort entire multi-file batch if any edit fails. Default true." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Validate and preview without writing. Default false." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx.cwd).editMany(params)
      const edited = result.files.reduce((sum, file) => sum + (file.applied?.length || 0), 0)
      const text = result.ok
        ? `${result.dryRun ? "Would apply" : "Applied"} ${edited} anchored edit(s) across ${result.files.length} file(s).`
        : `Multi-file anchored edit failed:\n${result.errors.join("\n")}`
      return { content: [{ type: "text", text }], details: result, isError: !result.ok }
    },
  })


  pi.registerTool({
    name: "pi_anchored_status",
    label: "anchored status",
    description: "Report dirac-edit-core Pi extension status.",
    executionMode: "parallel",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `dirac-edit-core Pi extension ready in ${ctx.cwd}` }],
        details: { cwd: ctx.cwd, version: "0.1.0" },
      }
    },
  })
}
