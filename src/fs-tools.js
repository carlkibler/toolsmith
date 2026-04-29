import fs from "node:fs/promises"
import path from "node:path"
import { AnchorStore } from "./anchors.js"
import { contentHash } from "./hash.js"
import { readAnchored } from "./read.js"
import { applyAnchoredEdits } from "./edit.js"

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
    }
  }

  async #assertReadableSize(absolute) {
    const stats = await fs.stat(absolute)
    if (!stats.isFile()) throw new Error(`not a file: ${absolute}`)
    if (stats.size > this.maxBytes) throw new Error(`file is too large (${stats.size} bytes > ${this.maxBytes})`)
  }
}
