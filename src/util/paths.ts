import fs from "node:fs"
import path from "node:path"

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveFrom(base: string, target: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(base, target)
}

export function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const UNSAFE_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]+/g
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Sanitize a string so it is safe to use as a single path segment. */
export function safeSegment(input: string): string {
  let cleaned = input
    .replace(UNSAFE_SEGMENT, "_")
    .replace(/\s+/g, "_")
    .replace(/^[._]+/, "")
    .replace(/[._]+$/, "")
    .replace(/_+/g, "_")
  if (cleaned.length === 0) return "unknown"
  if (RESERVED_SEGMENT.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned.slice(0, 80)
}

export function timestamp(): string {
  return new Date().toISOString()
}

/**
 * Make `location` behave as part of the OpenCode `project` so agents, skills and
 * commands defined under `<project>/.opencode` resolve for sessions created in
 * `location`.
 *
 * This lets the bridge keep every generated file (session folders, inboxes,
 * AGENTS.md) outside the project while the agent definitions stay in one place:
 * a directory link mirrors `.opencode` and the project's OpenCode config is
 * copied next to the link. Idempotent and safe to call repeatedly.
 */
export function ensureProjectLink(location: string, project: string): void {
  const from = path.resolve(location)
  const to = path.resolve(project)
  if (from === to) return
  ensureDir(from)

  const link = path.join(from, ".opencode")
  const target = path.join(to, ".opencode")
  if (!fs.existsSync(link) && fs.existsSync(target)) {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")
  }

  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const source = path.join(to, name)
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(from, name))
      break
    }
  }
}
