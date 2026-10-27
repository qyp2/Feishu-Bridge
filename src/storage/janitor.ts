import fs from "node:fs"
import path from "node:path"
import type { AppConfig } from "../config/index.js"
import type { Logger } from "../util/logger.js"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Deletes stale files on an interval: uploaded sources under each session's
 * `inbox/`, durable copies under `file-cache/`, and finished files under
 * `deliverables/`. Only files past their retention are removed; directory
 * structure stays so bindings never break.
 */
export class Janitor {
  private timer?: NodeJS.Timeout

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.sweep()
    this.timer = setInterval(() => this.sweep(), this.config.retention.sweepIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private sweep(): void {
    const now = Date.now()
    let removed = 0
    let bytes = 0
    const roots = new Set<string>()
    for (const bot of this.config.bots) {
      const root = bot.location ?? this.config.opencode.location
      if (roots.has(root)) continue
      roots.add(root)
      for (const botConfig of this.config.bots) {
        const botRoot = path.join(root, botConfig.name)
        const result = this.sweepSessions(botRoot, now)
        removed += result.removed
        bytes += result.bytes
      }
    }
    // file-cache/<chat>/ keeps one durable copy per upload.
    const cacheRoot = path.join(this.config.storageDir, "file-cache")
    let chatDirs: fs.Dirent[] = []
    try {
      chatDirs = fs.readdirSync(cacheRoot, { withFileTypes: true })
    } catch {
      chatDirs = []
    }
    for (const entry of chatDirs) {
      if (!entry.isDirectory()) continue
      const result = this.sweepTree(path.join(cacheRoot, entry.name), now - this.config.retention.cacheDays * DAY_MS)
      removed += result.removed
      bytes += result.bytes
    }
    if (removed > 0) {
      this.logger.info("Janitor sweep removed stale files", { removed, mb: Math.round((bytes / 1048576) * 10) / 10 })
    }
  }

  /** Walk `<root>/<chat>/` session folders and sweep inbox/ + deliverables/. */
  private sweepSessions(botRoot: string, now: number): { removed: number; bytes: number } {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(botRoot, { withFileTypes: true })
    } catch {
      return { removed: 0, bytes: 0 }
    }
    let removed = 0
    let bytes = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionDir = path.join(botRoot, entry.name)
      const inbox = this.sweepTree(path.join(sessionDir, "inbox"), now - this.config.retention.inboxDays * DAY_MS)
      const deliverables = this.sweepTree(
        path.join(sessionDir, "deliverables"),
        now - this.config.retention.deliverableDays * DAY_MS,
      )
      removed += inbox.removed + deliverables.removed
      bytes += inbox.bytes + deliverables.bytes
    }
    return { removed, bytes }
  }

  /** Remove files older than `before` directly inside `dir` (not recursive). */
  private sweepTree(dir: string, before: number): { removed: number; bytes: number } {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return { removed: 0, bytes: 0 }
    }
    let removed = 0
    let bytes = 0
    for (const name of names) {
      const full = path.join(dir, name)
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.mtimeMs >= before) continue
      try {
        fs.rmSync(full, { force: true })
        removed += 1
        bytes += stat.size
      } catch {
        // locked or racing with a write; leave it for the next sweep
      }
    }
    return { removed, bytes }
  }
}
