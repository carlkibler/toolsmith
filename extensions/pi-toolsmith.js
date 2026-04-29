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

export default function toolsmithPiExtension(pi) {
  pi.registerTool({
    name: "pi_anchored_read",
    label: "anchored read",
    description: "Read a file with stable opaque line anchors for precise batched edits. Prefer this before pi_anchored_edit.",
    promptSnippet: "Read file content with stable line anchors for precise low-token edits",
    promptGuidelines: [
      "For multi-location edits, prefer pi_anchored_read followed by one batched pi_anchored_edit call.",
      "When using pi_anchored_edit, include the full Anchor§line content reference exactly as returned. For one-line replace, repeat it as endAnchor.",
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
    name: "pi_anchored_search",
    label: "anchored search",
    description: "Search one file and return compact anchored snippets for precise low-token edits.",
    promptSnippet: "Search file content and return matching lines with stable edit anchors",
    promptGuidelines: [
      "Prefer pi_anchored_search over full pi_anchored_read when you know the text or symbol to edit.",
      "Copy the complete Anchor§line reference exactly into pi_anchored_edit.",
    ],
    executionMode: "parallel",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path to search." }),
      query: Type.String({ description: "Literal search text by default, or regex pattern when regex is true." }),
      sessionId: Type.Optional(Type.String({ description: "Anchor session id. Use same value for search/edit." })),
      regex: Type.Optional(Type.Boolean({ description: "Treat query as a JavaScript regex. Default false." })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive matching. Default false." })),
      contextLines: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      maxMatches: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx.cwd).search(params)
      return { content: [{ type: "text", text: result.text }], details: result }
    },
  })


  pi.registerTool({
    name: "pi_file_skeleton",
    label: "file skeleton",
    description: "Return a compact anchored outline of imports, classes, functions, and top-level declarations.",
    promptSnippet: "Inspect file structure with anchored declaration lines",
    promptGuidelines: [
      "Use pi_file_skeleton before full reads when you only need file structure.",
      "Use pi_get_function after finding the symbol you need to inspect or edit.",
    ],
    executionMode: "parallel",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path." }),
      sessionId: Type.Optional(Type.String({ description: "Anchor session id. Use same value for follow-up tools." })),
      maxLines: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx.cwd).skeleton(params)
      return { content: [{ type: "text", text: result.text }], details: result }
    },
  })

  pi.registerTool({
    name: "pi_get_function",
    label: "get function",
    description: "Return the anchored source range for a named function, class, type, or top-level declaration.",
    promptSnippet: "Read one named symbol with stable edit anchors",
    promptGuidelines: [
      "Prefer pi_get_function over full pi_anchored_read when changing one symbol.",
      "Copy complete Anchor§line references from the returned range into pi_anchored_edit.",
    ],
    executionMode: "parallel",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path." }),
      name: Type.String({ description: "Symbol name to extract." }),
      sessionId: Type.Optional(Type.String({ description: "Anchor session id. Use same value for edits." })),
      contextLines: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
      maxLines: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx.cwd).getFunction(params)
      return { content: [{ type: "text", text: result.text }], details: result, isError: result.found === false }
    },
  })


  pi.registerTool({
    name: "pi_symbol_replace",
    label: "symbol replace",
    description: "Replace text only inside one named function/class/type/top-level declaration.",
    promptSnippet: "Safely replace text scoped to one named symbol",
    promptGuidelines: [
      "Use pi_symbol_replace for small literal or regex replacements inside one symbol.",
      "Use dryRun true when uncertain; it will fail without writing if the symbol or search text is missing.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path." }),
      name: Type.String({ description: "Symbol name whose body/range should be edited." }),
      search: Type.String({ description: "Literal text by default, or regex when regex is true." }),
      replacement: Type.String({ description: "Replacement text." }),
      sessionId: Type.Optional(Type.String({ description: "Anchor session id." })),
      regex: Type.Optional(Type.Boolean({ description: "Treat search as a JavaScript regex. Default false." })),
      replaceAll: Type.Optional(Type.Boolean({ description: "Replace every match inside the symbol. Default false." })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive matching. Default true." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Validate and preview without writing. Default false." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx.cwd).symbolReplace(params)
      const text = result.ok
        ? `${result.dryRun ? "Would replace" : "Replaced"} ${result.matches} match(es) in ${result.name} (${result.path}). ${result.beforeHash} -> ${result.afterHash}`
        : `Symbol replace failed for ${params.path}:\n${result.errors.join("\n")}`
      return { content: [{ type: "text", text }], details: result, isError: !result.ok }
    },
  })


  pi.registerTool({
    name: "pi_anchored_edit",
    label: "anchored edit",
    description: "Apply exact anchor-targeted edits atomically. Use full Anchor§line references from pi_anchored_read or pi_anchored_search. For replace, endAnchor is required; repeat anchor for one-line replace.",
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
    description: "Report toolsmith Pi extension status.",
    executionMode: "parallel",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `toolsmith Pi extension ready in ${ctx.cwd}` }],
        details: { cwd: ctx.cwd, version: "0.1.0" },
      }
    },
  })
}
