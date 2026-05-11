import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { WorkspaceTools } from "../src/fs-tools.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"))
const workspaces = new Map()
const configuredWorkspaceCacheMax = Number(process.env.TOOLSMITH_PI_WORKSPACE_CACHE_MAX || 32)
const workspaceCacheMax = Number.isFinite(configuredWorkspaceCacheMax) && configuredWorkspaceCacheMax > 0 ? configuredWorkspaceCacheMax : 32

function toolsFor(cwd) {
  const key = path.resolve(cwd || process.cwd())
  if (workspaces.has(key)) {
    const tools = workspaces.get(key)
    workspaces.delete(key)
    workspaces.set(key, tools)
    return tools
  }
  const tools = new WorkspaceTools({ cwd: key })
  workspaces.set(key, tools)
  while (workspaces.size > workspaceCacheMax) workspaces.delete(workspaces.keys().next().value)
  return tools
}

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
  const lineCount = result.lineCount ?? result.endLine
  const isFullFile = result.startLine === 1 && result.endLine === lineCount
  const range = lineCount === 0
    ? "0 line(s)"
    : isFullFile
      ? `${lineCount} line(s)`
      : `lines ${result.startLine}–${result.endLine} of ${lineCount}`
  return `Anchored read ${result.path} (${range}, ${result.anchors?.length || 0} anchor(s), hash ${result.fileHash}). Full anchored content is in details.text.`
}

function searchSummary(result) {
  return `Anchored search ${result.path} matched ${result.matches?.length || 0} line(s) for ${JSON.stringify(result.query)} (hash ${result.fileHash}). Full anchored snippets are in details.text.`
}

function skeletonSummary(result) {
  return `File skeleton ${result.path}: ${result.entries?.length || 0} entr${result.entries?.length === 1 ? "y" : "ies"} (hash ${result.fileHash}). Full anchored skeleton is in details.text.`
}

function functionSummary(result) {
  return result.found
    ? `Function ${result.name} in ${result.path}: lines ${result.startLine}–${result.endLine}${result.truncated ? "+" : ""} (hash ${result.fileHash}). Full anchored source is in details.text.`
    : `Function ${result.name} not found in ${result.path} (hash ${result.fileHash}).`
}

const editSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["replace", "insert_after", "insert_before"] },
    edit_type: { type: "string", enum: ["replace", "insert_after", "insert_before"] },
    anchor: { type: "string", description: "Full Anchor§line reference from pi_anchored_read/search, including content after § (example: Aabc§beta; not Aabc§)." },
    endAnchor: { type: "string", description: "Full Anchor§line reference for replace end, including content after §. For one-line replace, repeat anchor exactly." },
    end_anchor: { type: "string", description: "Snake-case alias for endAnchor." },
    text: { type: "string", description: "Replacement or inserted text. Anchors are stripped if included." },
  },
  required: ["anchor"],
}

const anchorGuidelines = [
  "Anchors are file- and session-scoped opaque references; copy the full reference exactly, including the line text after the § delimiter. Never submit only the id plus delimiter, and never invent or truncate anchors.",
  "For replace edits, anchors are inclusive: endAnchor must be the exact final line of the construct being replaced, including closing syntax.",
  "If an edit fails from stale anchors or content mismatch, re-read/re-search the file and retry with fresh anchors.",
]

const surgicalGuidelines = [
  "Use pi_file_skeleton before broad reads when you need structure, then pi_get_function for the exact symbol.",
  "Use pi_symbol_replace for small scoped changes inside one named symbol before falling back to line anchors.",
]

export default function toolsmithPiExtension(pi) {
  pi.registerTool({
    name: "pi_anchored_read",
    label: "anchored read",
    description: "Read a file with stable opaque line anchors for precise batched edits. Prefer this before pi_anchored_edit.",
    promptSnippet: "Read file content with stable line anchors for precise low-token edits",
    promptGuidelines: [
      "For multi-location edits, prefer pi_anchored_read followed by one batched pi_anchored_edit call.",
      "When using pi_anchored_edit, include the full Anchor§line content reference exactly as returned. For one-line replace, repeat it as endAnchor.",
      ...anchorGuidelines,
      ...surgicalGuidelines,
    ],
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        sessionId: { type: "string", description: "Anchor session id. Use same value for read/edit." },
        startLine: { type: "number", minimum: 1 },
        endLine: { type: "number", minimum: 1 },
      },
      required: ["path"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx?.cwd).read(params)
      return { content: toolContent(result, readSummary(result)), details: result }
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
      ...anchorGuidelines,
    ],
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path to search." },
        query: { type: "string", description: "Literal search text by default, or regex pattern when regex is true." },
        sessionId: { type: "string", description: "Anchor session id. Use same value for search/edit." },
        regex: { type: "boolean", description: "Treat query as a JavaScript regex. Default false." },
        caseSensitive: { type: "boolean", description: "Case-sensitive matching. Default false." },
        contextLines: { type: "number", minimum: 0, maximum: 20 },
        maxMatches: { type: "number", minimum: 1, maximum: 200 },
      },
      required: ["path", "query"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx?.cwd).search(params)
      return { content: toolContent(result, searchSummary(result)), details: result }
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
      ...surgicalGuidelines,
    ],
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        sessionId: { type: "string", description: "Anchor session id. Use same value for follow-up tools." },
        maxLines: { type: "number", minimum: 1, maximum: 1000 },
      },
      required: ["path"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx?.cwd).skeleton(params)
      return { content: toolContent(result, skeletonSummary(result)), details: result }
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
      ...anchorGuidelines,
    ],
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        name: { type: "string", description: "Symbol name to extract." },
        sessionId: { type: "string", description: "Anchor session id. Use same value for edits." },
        contextLines: { type: "number", minimum: 0, maximum: 50 },
        maxLines: { type: "number", minimum: 1, maximum: 2000 },
      },
      required: ["path", "name"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx?.cwd).getFunction(params)
      return { content: toolContent(result, functionSummary(result)), details: result, isError: result.found === false }
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
      "If the change replaces a whole declaration manually, include decorators, exports, comments, and closing syntax in the replacement.",
    ],
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        name: { type: "string", description: "Symbol name whose body/range should be edited." },
        search: { type: "string", description: "Literal text by default, or regex when regex is true." },
        replacement: { type: "string", description: "Replacement text." },
        sessionId: { type: "string", description: "Anchor session id." },
        regex: { type: "boolean", description: "Treat search as a JavaScript regex. Default false." },
        replaceAll: { type: "boolean", description: "Replace every match inside the symbol. Default false." },
        caseSensitive: { type: "boolean", description: "Case-sensitive matching. Default true." },
        dryRun: { type: "boolean", description: "Validate and preview without writing. Default false." },
      },
      required: ["path", "name", "search"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx?.cwd).symbolReplace(params)
      const text = result.ok
        ? `${result.dryRun ? "Would replace" : "Replaced"} ${result.matches} match(es) in ${result.name} (${result.path}). ${result.beforeHash} -> ${result.afterHash}`
        : result.notFound
          ? `No match in ${params.path}: ${result.errors.join("; ")} — try pi_get_function to inspect the current source.`
          : `Symbol replace failed for ${params.path}:\n${result.errors.join("\n")}`
      return { content: [{ type: "text", text }], details: result, isError: !result.ok && !result.notFound }
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
      ...anchorGuidelines,
    ],
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        sessionId: { type: "string", description: "Anchor session id used for pi_anchored_read." },
        edits: { type: "array", items: editSchema, minItems: 1 },
        atomic: { type: "boolean", description: "Abort entire batch if any edit fails. Default true." },
        dryRun: { type: "boolean", description: "Validate and preview without writing. Default false." },
      },
      required: ["path", "edits"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx?.cwd).edit(params)
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
      ...anchorGuidelines,
    ],
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Default anchor session id used for files without their own sessionId." },
        files: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path." },
              sessionId: { type: "string", description: "Optional per-file anchor session id." },
              edits: { type: "array", items: editSchema, minItems: 1 },
            },
            required: ["path", "edits"],
          },
        },
        atomic: { type: "boolean", description: "Abort entire multi-file batch if any edit fails. Default true." },
        dryRun: { type: "boolean", description: "Validate and preview without writing. Default false." },
      },
      required: ["files"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await toolsFor(ctx?.cwd).editMany(params)
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
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const tools = toolsFor(ctx?.cwd)
      return {
        content: [{ type: "text", text: `toolsmith Pi extension ready in ${ctx?.cwd || process.cwd()} [workspace: ${tools.workspaceKey}]` }],
        details: { cwd: ctx?.cwd || process.cwd(), workspaceKey: tools.workspaceKey, version, workspaceCacheSize: workspaces.size, workspaceCacheMax },
      }
    },
  })
}
