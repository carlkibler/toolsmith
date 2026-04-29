import fs from "node:fs/promises"
import path from "node:path"
import { AnchorStore } from "./anchors.js"
import { contentHash } from "./hash.js"
import { readAnchored } from "./read.js"
import { applyAnchoredEdits } from "./edit.js"
import { searchAnchored } from "./search.js"
import { fileSkeleton, getFunction } from "./structure.js"
import { symbolReplace } from "./symbol-replace.js"
import { makeTelemetry } from "./telemetry.js"

const DEFAULT_MAX_BYTES = 512 * 1024

export class WorkspaceTools {
  constructor({ cwd = process.cwd(), store = new AnchorStore(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.cwd = path.resolve(cwd)
    this.store = store
    this.maxBytes = maxBytes
  }

  resolvePath(inputPath) {
    if (!inputPath || typeof inputPath !== "string") throw new Error("path is required")
    const absolute = path.resolve(this.cwd, inputPath)
    const relative = path.relative(this.cwd, absolute)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return { absolute, relative: relative || path.basename(absolute) }
    }
    throw new Error(`path escapes workspace: ${inputPath}`)
  }

  async read({ path: inputPath, sessionId = "default", startLine, endLine }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertReadableSize(absolute)
    const content = await fs.readFile(absolute, "utf8")
    return readAnchored({ path: relative, content, store: this.store, sessionId, startLine, endLine })
  }


  async search({ path: inputPath, sessionId = "default", query, regex = false, caseSensitive = false, contextLines = 1, maxMatches = 20 }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertReadableSize(absolute)
    const content = await fs.readFile(absolute, "utf8")
    return searchAnchored({ path: relative, content, store: this.store, sessionId, query, regex, caseSensitive, contextLines, maxMatches })
  }

  async skeleton({ path: inputPath, sessionId = "default", maxLines = 200 }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertReadableSize(absolute)
    const content = await fs.readFile(absolute, "utf8")
    return fileSkeleton({ path: relative, content, store: this.store, sessionId, maxLines })
  }

  async getFunction({ path: inputPath, sessionId = "default", name, contextLines = 0, maxLines = 400 }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertReadableSize(absolute)
    const content = await fs.readFile(absolute, "utf8")
    return getFunction({ path: relative, content, store: this.store, sessionId, name, contextLines, maxLines })
  }

  async symbolReplace({ path: inputPath, sessionId = "default", name, search, replacement = "", regex = false, replaceAll = false, caseSensitive = true, dryRun = false }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertReadableSize(absolute)
    const before = await fs.readFile(absolute, "utf8")
    const result = symbolReplace({ path: relative, content: before, store: this.store, sessionId, name, search, replacement, regex, replaceAll, caseSensitive })

    if (result.ok && result.changed && !dryRun) {
      await fs.writeFile(absolute, result.content, "utf8")
    }

    return {
      ...result,
      dryRun,
      telemetry: makeTelemetry({ operation: "symbol_replace", fullContent: before, requestPayload: { path: relative, sessionId, name, search, replacement, regex, replaceAll, caseSensitive, dryRun }, responseText: JSON.stringify({ ok: result.ok, errors: result.errors, matches: result.matches }), beforeContent: before, afterContent: result.content, anchors: result.anchors || [] }),
    }
  }

  async edit({ path: inputPath, sessionId = "default", edits, atomic = true, dryRun = false }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertReadableSize(absolute)
    const before = await fs.readFile(absolute, "utf8")
    const result = applyAnchoredEdits({ path: relative, content: before, store: this.store, sessionId, edits, atomic })
    const changed = result.content !== before

    if (result.ok && changed && !dryRun) {
      await fs.writeFile(absolute, result.content, "utf8")
    }

    return {
      ...result,
      path: relative,
      dryRun,
      changed,
      beforeHash: contentHash(before),
      afterHash: contentHash(result.content),
      telemetry: makeTelemetry({ operation: "anchored_edit", fullContent: before, requestPayload: { path: relative, sessionId, edits, atomic, dryRun }, responseText: JSON.stringify({ applied: result.applied, errors: result.errors }), beforeContent: before, afterContent: result.content, anchors: result.anchors || [] }),
    }
  }

  async editMany({ files, sessionId = "default", atomic = true, dryRun = false }) {
    if (!Array.isArray(files) || files.length === 0) throw new Error("files must be a non-empty array")

    const prepared = []
    const errors = []

    for (const file of files) {
      try {
        const { absolute, relative } = this.resolvePath(file.path)
        await this.#assertReadableSize(absolute)
        const before = await fs.readFile(absolute, "utf8")
        const result = applyAnchoredEdits({
          path: relative,
          content: before,
          store: this.store,
          sessionId: file.sessionId || sessionId,
          edits: file.edits,
          atomic,
        })
        const changed = result.content !== before
        const item = {
          ...result,
          path: relative,
          dryRun,
          changed,
          beforeHash: contentHash(before),
          afterHash: contentHash(result.content),
          telemetry: makeTelemetry({ operation: "anchored_edit_many:file", fullContent: before, requestPayload: { path: relative, sessionId: file.sessionId || sessionId, edits: file.edits, atomic, dryRun }, responseText: JSON.stringify({ applied: result.applied, errors: result.errors }), beforeContent: before, afterContent: result.content, anchors: result.anchors || [] }),
        }
        prepared.push({ absolute, item })
        if (!result.ok) errors.push(...result.errors.map((error) => `${relative}: ${error}`))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`${file?.path || "<unknown>"}: ${message}`)
      }
    }

    if (errors.length > 0 && atomic) {
      return { ok: false, dryRun, errors, files: prepared.map((entry) => entry.item) }
    }

    const writable = errors.length > 0 ? prepared.filter((entry) => entry.item.ok) : prepared
    if (!dryRun) {
      for (const entry of writable) {
        if (entry.item.changed) await fs.writeFile(entry.absolute, entry.item.content, "utf8")
      }
    }

    return { ok: errors.length === 0, dryRun, errors, files: prepared.map((entry) => entry.item) }
  }

  async #assertReadableSize(absolute) {
    const stats = await fs.stat(absolute)
    if (!stats.isFile()) throw new Error(`not a file: ${absolute}`)
    if (stats.size > this.maxBytes) throw new Error(`file is too large (${stats.size} bytes > ${this.maxBytes})`)
  }
}
