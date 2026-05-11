import path from "node:path"
import { contentHash } from "./hash.js"
import { searchAnchored } from "./search.js"
import { estimateTokens } from "./telemetry.js"

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".beads", ".dolt", "coverage"])
const BINARY_EXT_RE = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|dmg|sqlite|db|mp4|mov|mp3|wav|woff2?|ttf|otf)$/i

export async function findAndAnchor({
  rootAbsolute,
  rootRelative,
  readFile,
  statPath,
  listDir,
  store,
  sessionId = "default",
  workspaceKey,
  query,
  regex = false,
  caseSensitive = false,
  contextLines = 2,
  maxMatches = 20,
  maxFiles = 80,
  maxMatchesPerFile = 5,
  glob,
}) {
  if (!query || typeof query !== "string") throw new Error("query is required")
  const stats = await statPath(rootAbsolute)
  const isDirectory = stats.isDirectory()
  const parsedPerFileLimit = Number(maxMatchesPerFile)
  const perFileLimit = Number.isFinite(parsedPerFileLimit) && parsedPerFileLimit > 0 ? parsedPerFileLimit : Math.max(1, Number(maxMatches) || 20)
  const collection = isDirectory
    ? await collectFiles({ rootAbsolute, rootRelative, listDir, statPath, glob, maxFiles })
    : { files: [{ absolute: rootAbsolute, relative: rootRelative }], truncatedCandidates: false }
  const files = collection.files

  const matches = []
  const sections = []
  let scannedFiles = 0
  let scannedBytes = 0
  let truncated = collection.truncatedCandidates
  let searchError = null

  for (const file of files) {
    if (matches.length >= maxMatches) { truncated = true; break }
    let content
    try {
      content = await readFile(file.absolute)
    } catch {
      continue
    }
    scannedFiles += 1
    scannedBytes += Buffer.byteLength(content, "utf8")
    const result = searchAnchored({
      path: file.relative,
      content,
      store,
      sessionId,
      workspaceKey,
      query,
      regex,
      caseSensitive,
      contextLines,
      maxMatches: isDirectory ? Math.min(maxMatches - matches.length, perFileLimit) : maxMatches - matches.length,
    })
    if (result.error) {
      searchError = `${file.relative}: ${result.error}`
      truncated = true
      break
    }
    if (result.matches.length === 0) continue
    sections.push(result.text)
    for (const match of result.matches) matches.push({ ...match, path: file.relative, fileHash: contentHash(content) })
  }

  const responseBody = sections.length ? sections.join("\n\n") : "(no matches)"
  const workspaceTag = workspaceKey ? `[Workspace: ${workspaceKey}] ` : ""
  const errorNote = searchError ? ` [Error: ${searchError}]` : ""
  const candidateNote = collection.truncatedCandidates ? ` [Candidate files: ${files.length}+ truncated at maxFiles=${maxFiles}]` : ` [Candidate files: ${files.length}]`
  const text = `${workspaceTag}[Find: ${query}] [Files scanned: ${scannedFiles}]${candidateNote} [Files matched: ${sections.length}] [Matches: ${matches.length}${truncated ? "+" : ""}]${errorNote}\n${searchError ? `(error: ${searchError})` : responseBody}`
  return {
    path: rootRelative,
    query,
    regex,
    caseSensitive,
    contextLines,
    maxMatches,
    maxFiles,
    maxMatchesPerFile: perFileLimit,
    glob,
    scannedFiles,
    candidateFiles: files.length,
    candidateCollectionTruncated: collection.truncatedCandidates,
    matchedFiles: sections.length,
    matches,
    truncated,
    error: searchError,
    text,
    telemetry: telemetry({ operation: "find_and_anchor", scannedBytes, requestPayload: { path: rootRelative, query, regex, caseSensitive, contextLines, maxMatches, maxFiles, maxMatchesPerFile: perFileLimit, glob, sessionId }, responseText: text, anchorCount: matches.length }),
  }
}

async function collectFiles({ rootAbsolute, rootRelative, listDir, statPath, glob, maxFiles }) {
  const files = []
  const matcher = glob ? globMatcher(glob) : null
  let truncatedCandidates = false

  async function walk(abs, rel) {
    if (files.length >= maxFiles) { truncatedCandidates = true; return }
    const entries = await listDir(abs)
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncatedCandidates = true; return }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(abs, entry.name), rel ? path.join(rel, entry.name) : entry.name)
      } else if (entry.isFile()) {
        const childRel = rel ? path.join(rel, entry.name) : entry.name
        const displayRel = rootRelative === "." ? childRel : path.join(rootRelative, childRel)
        if (BINARY_EXT_RE.test(entry.name)) continue
        if (matcher && !matcher(displayRel) && !matcher(childRel) && !matcher(entry.name)) continue
        const absolute = path.join(abs, entry.name)
        const st = await statPath(absolute)
        if (st.size > 512 * 1024) continue
        files.push({ absolute, relative: displayRel })
      }
    }
  }

  await walk(rootAbsolute, rootRelative === "." ? "" : "")
  return { files, truncatedCandidates }
}

function globMatcher(glob) {
  const pattern = String(glob).split(/[,\s]+/u).filter(Boolean).map((item) => globToRegExp(item))
  return (value) => pattern.some((regex) => regex.test(value))
}

function globToRegExp(glob) {
  let out = ""
  for (let i = 0; i < glob.length; i += 1) {
    if (glob.slice(i, i + 3) === "**/") {
      out += "(?:.*/)?"
      i += 2
      continue
    }
    const char = glob[i]
    if (char === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i += 1 } else out += "[^/]*"
    } else if (char === "?") {
      out += "[^/]"
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${out}$`)
}

function telemetry({ operation, scannedBytes, requestPayload, responseText, anchorCount }) {
  const requestBytes = Buffer.byteLength(JSON.stringify(requestPayload || {}), "utf8")
  const responseBytes = Buffer.byteLength(String(responseText || ""), "utf8")
  return {
    operation,
    fullBytes: scannedBytes,
    requestBytes,
    responseBytes,
    avoidedBytes: Math.max(0, scannedBytes - responseBytes),
    estimatedFullTokens: Math.ceil(scannedBytes / 4),
    estimatedResponseTokens: estimateTokens(responseText),
    estimatedTokensAvoided: Math.max(0, Math.ceil(scannedBytes / 4) - estimateTokens(responseText)),
    anchorCount,
  }
}
