import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { args, option } from "./argv.js"
import { installContext, parsePiToolsmithConfig, realPathOrNull, tryCommand } from "./config.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, "..")

export const PI_TOOLSMITH_TOOLS = [
  "pi_file_skeleton",
  "pi_get_function",
  "pi_symbol_replace",
  "pi_anchored_search",
  "pi_anchored_read",
  "pi_anchored_edit",
  "pi_anchored_edit_many",
  "pi_anchored_status",
]

export const PI_STRICT_PROMPT = `Toolsmith is the file-editing harness for this Pi session.

Use Toolsmith tools for code/file navigation and mutation:
- Start with pi_file_skeleton, pi_get_function, or pi_anchored_search instead of full reads when possible.
- Use pi_symbol_replace for one named function/class/symbol; provide the complete intended replacement text.
- Use pi_anchored_read/search outputs immediately with pi_anchored_edit/edit_many; copy the full Anchor§line exactly, including the text after §.
- Batch all non-overlapping edits to the same file in one pi_anchored_edit call; batch cross-file edits with pi_anchored_edit_many.
- For replace edits, anchors are inclusive. Make endAnchor the precise final line of the construct, including closing syntax.
- If anchors are stale or content mismatches, re-read/re-search and retry rather than switching to native editing.`

export function tryPi(piArgs) {
  return tryCommand("pi", piArgs)
}

export function piPackageSource(ctx = installContext()) {
  if (ctx.kind?.startsWith("git-checkout") && ctx.repoRoot) return ctx.repoRoot
  return REPO_ROOT
}

function verboseOutput() {
  return /^(1|true|yes|on|debug|verbose)$/i.test(String(process.env.TOOLSMITH_VERBOSE || process.env.TOOLSMITH_DEBUG || ""))
}

function piPackageSourceLabel(source, ctx = installContext()) {
  if (ctx.kind?.startsWith("git-checkout") && ctx.repoRoot && realPathOrNull(source) === realPathOrNull(ctx.repoRoot)) {
    return verboseOutput() ? `local checkout (${source})` : "local checkout"
  }
  if (ctx.kind === "npm-global") return verboseOutput() ? `release package (${source})` : ""
  return verboseOutput() ? source : ""
}

export function piInstallHealth(config = parsePiToolsmithConfig(), source = piPackageSource()) {
  if (!config) return { state: "missing", source }
  if (config.error) return { state: "error", source, error: config.error, path: config.path }

  const entries = Array.isArray(config.toolsmithEntries)
    ? config.toolsmithEntries
    : (config.installed ? [{ source: config.installed, realPath: config.installedRealPath || null }] : [])
  if (entries.length === 0) return { state: "missing", source, path: config.path }

  const expectedReal = realPathOrNull(source)
  const staleEntries = entries.filter((entry) => {
    if (entry.source === source) return false
    if (expectedReal && entry.realPath === expectedReal) return false
    return true
  })
  const active = staleEntries[0] || entries[0]
  const installedReal = active.realPath || null

  if (staleEntries.length > 0) {
    return {
      state: "drift",
      source,
      path: config.path,
      installed: active.source,
      installedRealPath: installedReal,
      expectedRealPath: expectedReal || source,
      staleEntries,
    }
  }

  return { state: "ok", source, path: config.path, installed: entries[0].source, installedRealPath: entries[0].realPath || null }
}

function piResult(state, messages = []) {
  return { label: "Pi.dev", state, messages: messages.map((message) => `  ${message}`) }
}

function prunePiPackageEntries(config, entries) {
  if (!config?.path || !entries?.length) return false
  let data
  try { data = JSON.parse(readFileSync(config.path, "utf8")) } catch { return false }
  if (!Array.isArray(data?.packages)) return false
  const staleSources = new Set(entries.map((entry) => entry.source))
  const packages = data.packages.filter((source) => !staleSources.has(source))
  if (packages.length === data.packages.length) return false
  data.packages = packages
  writeFileSync(config.path, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  return true
}

export function setupPiResult(force = false) {
  const version = tryPi(["--version"])
  if (version === null) return piResult("skipped")
  if (version?.error) return piResult("error", [`Pi.dev: error checking — ${version.error}`])

  const source = piPackageSource()
  const config = parsePiToolsmithConfig()
  const health = piInstallHealth(config, source)
  const messages = []

  if (health.state === "error") {
    return piResult("error", [`Pi.dev: settings unreadable — ${health.error} in ${health.path}`])
  }

  if (health.state === "ok" && !force) {
    return piResult("already", ["Pi.dev: already installed (--force to update)"])
  }

  if (health.state === "drift") {
    const installed = health.installedRealPath || health.installed || "unknown"
    messages.push(verboseOutput()
      ? `Pi.dev: package drift detected — refreshing (${installed} → ${health.expectedRealPath})`
      : "Pi.dev: package drift detected — refreshing")
    const failedRemovals = []
    for (const entry of health.staleEntries || []) {
      const remove = spawnSync("pi", ["remove", entry.source], { encoding: "utf8" })
      if (remove.status === 0) {
        messages.push(verboseOutput() ? `Pi.dev: removed stale package (${entry.source})` : "Pi.dev: removed stale package")
      } else {
        const msg = (remove.stderr || remove.stdout || "").trim()
        messages.push(`Pi.dev: failed removing stale package ${entry.source} — ${msg}`)
        failedRemovals.push(entry)
      }
    }
    if (failedRemovals.length > 0 && prunePiPackageEntries(config, failedRemovals)) {
      messages.push("Pi.dev: pruned stale package entries from settings")
    }
  }

  const result = spawnSync("pi", ["install", source], { encoding: "utf8" })
  if (result.status === 0) {
    const label = piPackageSourceLabel(source)
    messages.push(`Pi.dev: ${health.state === "missing" ? "installed" : "refreshed"}${label ? ` ${label}` : ""}`)
    return piResult(health.state === "missing" ? "registered" : "refreshed", messages)
  }

  const msg = (result.stderr || result.stdout || "").trim()
  messages.push(`Pi.dev: failed — ${msg}`)
  return piResult("error", messages)
}

export function setupPi(force = false) {
  const result = setupPiResult(force)
  for (const message of result.messages || []) console.log(message)
  return result.state !== "error" && result.state !== "skipped"
}

export function runPi() {
  const version = tryPi(["--version"])
  if (version === null) {
    console.error("pi not found. Install Pi first, then run `toolsmith setup --force`.")
    process.exitCode = 127
    return
  }
  if (version?.error) {
    console.error(`pi failed: ${version.error}`)
    process.exitCode = 1
    return
  }

  const forwarded = args.filter((arg) => arg !== "--with-builtins")
  const withBuiltins = args.includes("--with-builtins")
  const hasBuiltinMode = withBuiltins || args.includes("--no-builtin-tools") || args.includes("-nbt") || args.includes("--no-tools") || args.includes("-nt")
  const hasToolFilter = args.includes("--tools") || args.includes("-t") || args.includes("--no-tools") || args.includes("-nt")
  const piArgs = []

  if (!hasBuiltinMode) piArgs.push("--no-builtin-tools")
  if (!hasToolFilter && !withBuiltins) piArgs.push("--tools", option("--tools") || PI_TOOLSMITH_TOOLS.join(","))
  piArgs.push("--append-system-prompt", PI_STRICT_PROMPT)
  piArgs.push(...forwarded)

  const result = spawnSync("pi", piArgs, { stdio: "inherit" })
  process.exitCode = result.status ?? 0
}
