import {
  ANCHOR_DELIMITER,
  formatAnchoredLine,
  splitAnchorReference,
  splitLines,
  stripAnchors,
} from "./anchors.js"

const VALID_ANCHOR = /^A[a-zA-Z0-9]+$/

export function applyAnchoredEdits({ path, content, store, sessionId, workspaceKey, workspace, edits, atomic = true }) {
  if (!store) throw new Error("applyAnchoredEdits requires an AnchorStore")
  if (!Array.isArray(edits)) throw new Error("edits must be an array")

  const lines = splitLines(content)
  const anchors = store.reconcile(path, content, { sessionId, workspaceKey })
  const resolved = []
  const errors = []
  const warnings = []

  if (workspace && workspaceKey && workspace !== workspaceKey) {
    const terse = process.env.TOOLSMITH_TERSE === "1"
    const footer = terse ? "" : " If this is unexpected, re-read the file in the current workspace."
    warnings.push(`workspace mismatch: anchors were issued under workspace "${workspaceKey}" but edit specified workspace "${workspace}"; edit applied anyway in 0.1.x but will be rejected in 0.2.x.${footer}`)
  }

  for (const [index, edit] of edits.entries()) {
    const result = resolveEdit(edit, index, lines, anchors)
    if (result.error) errors.push(result.error)
    else resolved.push(result.value)
  }

  const overlapError = findOverlap(resolved)
  if (overlapError) errors.push(overlapError)

  if (overlapError || (errors.length > 0 && atomic)) {
    const validatedEdits = resolved.filter((e) => !e.invalid).map((e) => e.editIndex)
    return { ok: false, content, errors, warnings, applied: [], validatedEdits }
  }

  const usable = errors.length > 0 ? resolved.filter((edit) => !edit.invalid) : resolved
  const nextLines = [...lines]
  const applied = []

  for (const edit of [...usable].sort((left, right) => right.spliceIndex - left.spliceIndex || right.editIndex - left.editIndex)) {
    nextLines.splice(edit.spliceIndex, edit.deleteCount, ...edit.replacementLines)
    applied.push({ type: edit.type, anchor: edit.anchor, endAnchor: edit.endAnchor, linesAdded: edit.replacementLines.length, linesDeleted: edit.deleteCount })
  }

  const nextContent = nextLines.join("\n")
  const nextAnchors = store.reconcile(path, nextContent, { sessionId, workspaceKey })

  return { ok: errors.length === 0, content: nextContent, errors, warnings, applied: applied.reverse(), anchors: nextAnchors }
}

function resolveEdit(edit, editIndex, lines, anchors) {
  const type = edit.type || edit.edit_type || "replace"
  if (!["replace", "insert_after", "insert_before"].includes(type)) {
    return fail(editIndex, `unsupported edit type: ${type}`)
  }

  const start = resolveAnchor("anchor", edit.anchor, lines, anchors, editIndex)
  if (start.error) return fail(editIndex, start.error)

  let end = start
  if (type === "replace") {
    end = resolveAnchor("endAnchor", edit.endAnchor || edit.end_anchor, lines, anchors, editIndex)
    if (end.error) return fail(editIndex, end.error)
    if (end.index < start.index) return fail(editIndex, "endAnchor must not precede anchor")
  }

  const replacementText = stripAnchors(edit.text ?? "")
  const replacementLines = replacementText.length === 0 ? [] : replacementText.split(/\r?\n/)

  if (type === "insert_after") {
    return ok({ type, anchor: start.anchor, endAnchor: start.anchor, editIndex, rangeStart: start.index + 1, rangeEnd: start.index + 1, spliceIndex: start.index + 1, deleteCount: 0, replacementLines })
  }

  if (type === "insert_before") {
    return ok({ type, anchor: start.anchor, endAnchor: start.anchor, editIndex, rangeStart: start.index, rangeEnd: start.index, spliceIndex: start.index, deleteCount: 0, replacementLines })
  }

  return ok({ type, anchor: start.anchor, endAnchor: end.anchor, editIndex, rangeStart: start.index, rangeEnd: end.index + 1, spliceIndex: start.index, deleteCount: end.index - start.index + 1, replacementLines })
}

function resolveAnchor(field, reference, lines, anchors, editIndex) {
  const { anchor, content } = splitAnchorReference(reference)
  if (!anchor) return { error: `${field} missing in edit ${editIndex}` }
  if (!VALID_ANCHOR.test(anchor)) return { error: `${field} "${anchor}" is malformed; expected A...${ANCHOR_DELIMITER}line` }

  const index = anchors.indexOf(anchor)
  if (index === -1) {
    const hint = anchors.length === 0
      ? `no anchors registered for this path/session; call anchored_read first`
      : `not found in ${anchors.length} current anchors; re-read the file if it has changed`
    return { error: `${field} "${anchor}" ${hint}` }
  }
  if (content === null) return { error: `${field} "${anchor}" must include exact line content after ${ANCHOR_DELIMITER}; use ${JSON.stringify(formatAnchoredLine(anchor, lines[index]))}` }
  if (content.includes("\n") || content.includes("\r")) return { error: `${field} "${anchor}" must reference exactly one line` }
  if (lines[index] !== content) return { error: `${field} "${anchor}" content mismatch; expected full reference ${JSON.stringify(formatAnchoredLine(anchor, lines[index]))}, got line content ${JSON.stringify(content)}${anchorMismatchHint()}` }

  return { anchor, index }
}

function anchorMismatchHint() {
  return process.env.TOOLSMITH_TERSE === "1"
    ? ""
    : "\nHint: this protects against silent overwrites. Retry with the anchor above, or call `file_skeleton` to re-orient."
}

function findOverlap(resolved) {
  const sorted = [...resolved].sort((left, right) => left.rangeStart - right.rangeStart || left.rangeEnd - right.rangeEnd)
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].rangeStart < sorted[index - 1].rangeEnd) {
      const a = sorted[index - 1]
      const b = sorted[index]
      return `edits overlap: edit[${a.editIndex}] (${a.anchor}) and edit[${b.editIndex}] (${b.anchor}) share a line range`
    }
  }
  return null
}

function ok(value) {
  return { value }
}

function fail(editIndex, message) {
  return { error: `edit ${editIndex}: ${message}` }
}
