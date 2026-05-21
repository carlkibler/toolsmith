// Provenance markers stamped onto every artifact Toolsmith installs into a
// user's or project's harness areas. Per the Self-Containment Doctrine in
// CLAUDE.md, any file or config entry Toolsmith creates must declare that it
// belongs to Toolsmith and link back to the source repo and npm package.

export const TOOLSMITH_REPO_URL = "https://github.com/carlkibler/toolsmith"
export const TOOLSMITH_NPM_URL = "https://www.npmjs.com/package/@carlkibler/toolsmith"

// One-line provenance, suitable as a trailing shell comment, a TOML `#` line,
// or inside a Markdown/HTML comment.
export function provenanceTag() {
  return `Toolsmith — ${TOOLSMITH_REPO_URL} — ${TOOLSMITH_NPM_URL}`
}

// Multi-line `#`-commented header for a shell script Toolsmith writes and owns.
// `purpose` is a short description of what the script does.
export function shellProvenanceHeader(purpose) {
  const lines = ["# Installed and managed by Toolsmith."]
  if (purpose) lines.push(`# ${purpose}`)
  lines.push(
    `# Source:  ${TOOLSMITH_REPO_URL}`,
    `# Package: ${TOOLSMITH_NPM_URL}`,
    "# Do not edit by hand — 'toolsmith setup' / 'toolsmith update' rewrites this file.",
  )
  return lines.join("\n")
}
