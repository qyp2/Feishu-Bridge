import fs from "node:fs"
import path from "node:path"

/** Read and parse a JSON file, returning a fallback when it does not exist. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Atomically write JSON (write to temp then rename). */
export function writeJson(file: string, value: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8")
  fs.renameSync(tmp, file)
}
