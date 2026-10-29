import fs from "node:fs"
import path from "node:path"

const LOCK_NAME = "bridge.lock"

/** Refuse to start when another bridge already holds the lock for this data directory. */
export function acquireProcessLock(storageDir: string): void {
  fs.mkdirSync(storageDir, { recursive: true })
  const file = path.join(storageDir, LOCK_NAME)
  const existing = readPid(file)
  if (existing > 0 && existing !== process.pid && isAlive(existing)) {
    process.stderr.write(`feishu-bridge 已在运行（pid ${existing}），本次退出。\n`)
    process.exit(1)
  }
  fs.writeFileSync(file, String(process.pid), "utf8")
  process.on("exit", () => {
    try {
      if (readPid(file) === process.pid) fs.rmSync(file, { force: true })
    } catch {
      // the next start treats a stale lock as free
    }
  })
}

function readPid(file: string): number {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim())
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
