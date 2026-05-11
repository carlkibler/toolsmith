import fs from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import path from "node:path"

// O_NOFOLLOW: fail if final path component is a symlink. Not available on Windows.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW || 0
import { AnchorStore } from "./anchors.js"
import { contentHash } from "./hash.js"
import { readAnchored } from "./read.js"
import { applyAnchoredEdits } from "./edit.js"
import { searchAnchored } from "./search.js"
import { fileSkeleton, getFunction } from "./structure.js"
import { symbolReplace } from "./symbol-replace.js"
import { findAndAnchor } from "./find-anchor.js"
import { makeTelemetry } from "./telemetry.js"

const DEFAULT_MAX_BYTES = 512 * 1024

export class WorkspaceTools {
  #realCwd = null

  constructor({ cwd = process.cwd(), store = new AnchorStore(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.cwd = path.resolve(cwd)
    this.store = store
    this.maxBytes = maxBytes
    const base = path.basename(this.cwd)
    const sanitized = base.replace(/[^A-Za-z0-9._-]/g, "_")
    this.workspaceKey = sanitized || "workspace"
  }

  resolvePath(inputPath) {
    if (!inputPath || typeof inputPath !== "string") throw new Error("path is required")
    if (inputPath.includes("\0")) throw new Error("path must not contain null bytes")
    const absolute = path.resolve(this.cwd, inputPath)
    const relative = path.relative(this.cwd, absolute)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return { absolute, relative: relative || path.basename(absolute) }
    }
    throw new Error(`path escapes workspace: ${inputPath}`)
  }

  async read({ path: inputPath, sessionId = "default", startLine, endLine }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertContained(absolute)
    const content = await this.#openAndRead(absolute)
    return readAnchored({ path: relative, content, store: this.store, sessionId, workspaceKey: this.workspaceKey, startLine, endLine })
  }


  async search({ path: inputPath, sessionId = "default", query, regex = false, caseSensitive = false, contextLines = 1, maxMatches = 20 }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertContained(absolute)
    const content = await this.#openAndRead(absolute)
    return searchAnchored({ path: relative, content, store: this.store, sessionId, workspaceKey: this.workspaceKey, query, regex, caseSensitive, contextLines, maxMatches })
  }

  async skeleton({ path: inputPath, sessionId = "default", maxLines = 200 }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertContained(absolute)
    const content = await this.#openAndRead(absolute)
    return fileSkeleton({ path: relative, content, store: this.store, sessionId, workspaceKey: this.workspaceKey, maxLines })
  }

  async getFunction({ path: inputPath, sessionId = "default", name, contextLines = 0, maxLines = 400 }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertContained(absolute)
    const content = await this.#openAndRead(absolute)
    return getFunction({ path: relative, content, store: this.store, sessionId, workspaceKey: this.workspaceKey, name, contextLines, maxLines })
  }
  async findAndAnchor({ path: inputPath = ".", sessionId = "default", query, regex = false, caseSensitive = false, contextLines = 2, maxMatches = 20, maxFiles = 80, maxMatchesPerFile = 5, glob }) {
    const { absolute } = this.resolvePath(inputPath)
    await this.#assertContained(absolute)
    const rootRelative = path.relative(this.cwd, absolute) || "."
    return findAndAnchor({
      rootAbsolute: absolute,
      rootRelative,
      readFile: async (target) => {
        await this.#assertContained(target)
        return this.#openAndRead(target)
      },
      statPath: async (target) => {
        await this.#assertContained(target)
        return fs.stat(target)
      },
      listDir: async (target) => {
        await this.#assertContained(target)
        return fs.readdir(target, { withFileTypes: true })
      },
      store: this.store,
      sessionId,
      workspaceKey: this.workspaceKey,
      query,
      regex,
      caseSensitive,
      contextLines,
      maxMatches,
      maxFiles,
      maxMatchesPerFile,
      glob,
    })
  }


  async symbolReplace({ path: inputPath, sessionId = "default", name, search, replacement = "", regex = false, replaceAll = false, caseSensitive = true, dryRun = false }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertContained(absolute)
    const before = await this.#openAndRead(absolute)
    const result = symbolReplace({ path: relative, content: before, store: this.store, sessionId, workspaceKey: this.workspaceKey, name, search, replacement, regex, replaceAll, caseSensitive })

    if (result.ok && result.changed && !dryRun) {
      await this.#openAndWrite(absolute, result.content)
    }

    return {
      ...result,
      dryRun,
      telemetry: makeTelemetry({ operation: "symbol_replace", workspaceKey: this.workspaceKey, fullContent: before, requestPayload: { path: relative, sessionId, name, search, replacement, regex, replaceAll, caseSensitive, dryRun }, responseText: JSON.stringify({ ok: result.ok, errors: result.errors, matches: result.matches }), beforeContent: before, afterContent: result.content, anchors: result.anchors || [] }),
    }
  }

  async edit({ path: inputPath, sessionId = "default", workspace, edits, atomic = true, dryRun = false }) {
    const { absolute, relative } = this.resolvePath(inputPath)
    await this.#assertContained(absolute)
    const before = await this.#openAndRead(absolute)
    const result = applyAnchoredEdits({ path: relative, content: before, store: this.store, sessionId, workspaceKey: this.workspaceKey, workspace, edits, atomic })
    const changed = result.content !== before

    if (result.ok && changed && !dryRun) {
      await this.#openAndWrite(absolute, result.content)
    }

    return {
      ...result,
      path: relative,
      dryRun,
      changed,
      beforeHash: contentHash(before),
      afterHash: contentHash(result.content),
      telemetry: makeTelemetry({ operation: "anchored_edit", workspaceKey: this.workspaceKey, fullContent: before, requestPayload: { path: relative, sessionId, edits, atomic, dryRun }, responseText: JSON.stringify({ applied: result.applied, errors: result.errors }), beforeContent: before, afterContent: result.content, anchors: result.anchors || [] }),
    }
  }

  async editMany({ files, sessionId = "default", workspace, atomic = true, dryRun = false }) {
    if (!Array.isArray(files) || files.length === 0) throw new Error("files must be a non-empty array")

    const prepared = []
    const errors = []

    const reads = await Promise.all(files.map(async (file) => {
      try {
        const { absolute, relative } = this.resolvePath(file.path)
        await this.#assertContained(absolute)
        const before = await this.#openAndRead(absolute)
        return { file, absolute, relative, before }
      } catch (error) {
        return { file, error }
      }
    }))

    const seenPaths = new Set()
    for (const entry of reads) {
      if (entry.error) {
        const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
        errors.push(`${entry.file?.path || "<unknown>"}: ${message}`)
        continue
      }
      const { file, absolute, relative, before } = entry
      if (seenPaths.has(absolute)) {
        errors.push(`${relative}: duplicate file entry; combine edits for the same file into one entry`)
        continue
      }
      seenPaths.add(absolute)
      const result = applyAnchoredEdits({
        path: relative,
        content: before,
        store: this.store,
        sessionId: file.sessionId || sessionId,
        workspaceKey: this.workspaceKey,
        workspace,
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
        telemetry: makeTelemetry({ operation: "anchored_edit_many:file", workspaceKey: this.workspaceKey, fullContent: before, requestPayload: { path: relative, sessionId: file.sessionId || sessionId, edits: file.edits, atomic, dryRun }, responseText: JSON.stringify({ applied: result.applied, errors: result.errors }), beforeContent: before, afterContent: result.content, anchors: result.anchors || [] }),
      }
      prepared.push({ absolute, item })
      if (!result.ok) errors.push(...result.errors.map((error) => `${relative}: ${error}`))
    }

    const allWarnings = prepared.flatMap((entry) => entry.item.warnings || [])

    if (errors.length > 0 && atomic) {
      return { ok: false, dryRun, errors, warnings: allWarnings, files: prepared.map((entry) => entry.item) }
    }

    const writable = errors.length > 0 ? prepared.filter((entry) => entry.item.ok) : prepared
    if (!dryRun) {
      for (const entry of writable) {
        if (entry.item.changed) await this.#openAndWrite(entry.absolute, entry.item.content)
      }
    }

    return { ok: errors.length === 0, dryRun, errors, warnings: allWarnings, files: prepared.map((entry) => entry.item) }
  }

  async #assertContained(absolute) {
    let real
    try {
      real = await fs.realpath(absolute)
    } catch (e) {
      if (e.code === "ENOENT") return
      throw e
    }
    if (!this.#realCwd) this.#realCwd = await fs.realpath(this.cwd)
    const rel = path.relative(this.#realCwd, real)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace via symlink: ${path.relative(this.cwd, absolute)}`)
    }
  }

  async #openAndRead(absolute) {
    let fd
    try {
      fd = await fs.open(absolute, fsConstants.O_RDONLY | O_NOFOLLOW)
    } catch (e) {
      if (e.code === "ELOOP" && O_NOFOLLOW !== 0) {
        // File is a symlink already verified by assertContained — re-verify and open normally
        await this.#assertContained(absolute)
        fd = await fs.open(absolute, fsConstants.O_RDONLY)
      } else {
        throw new Error(`${path.relative(this.cwd, absolute)}: ${e.message}`)
      }
    }
    try {
      const stats = await fd.stat()
      if (!stats.isFile()) throw new Error(`not a file: ${path.relative(this.cwd, absolute)}`)
      if (stats.size > this.maxBytes) throw new Error(`file is too large (${stats.size} bytes > ${this.maxBytes}); use startLine/endLine for partial reads, or file_skeleton for structure`)
      return await fd.readFile("utf8")
    } finally {
      await fd.close()
    }
  }

  async #openAndWrite(absolute, content) {
    const contentBytes = Buffer.byteLength(content, "utf8")
    if (contentBytes > this.maxBytes) throw new Error(`edit result exceeds size limit (${contentBytes} bytes > ${this.maxBytes}); split into smaller edits`)
    const writeFlags = fsConstants.O_WRONLY | fsConstants.O_TRUNC | O_NOFOLLOW
    let fd
    try {
      fd = await fs.open(absolute, writeFlags)
    } catch (e) {
      if (e.code === "ELOOP" && O_NOFOLLOW !== 0) {
        throw new Error(`${path.relative(this.cwd, absolute)}: refusing to write through symlink`)
      } else {
        throw new Error(`${path.relative(this.cwd, absolute)}: ${e.message}`)
      }
    }
    try {
      await fd.writeFile(content, "utf8")
    } finally {
      await fd.close()
    }
  }
}
