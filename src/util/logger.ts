import fs from "node:fs"
import path from "node:path"
import { ensureDir, today, timestamp } from "./paths.js"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerOptions {
  level?: LogLevel
  dir?: string
  /** When true, human readable console output is used instead of JSON lines. */
  pretty?: boolean
  name?: string
}

type Meta = Record<string, unknown> | undefined

/**
 * Minimal structured logger that writes JSON lines to a rotating daily file and
 * to the console. No external dependency so the bridge stays light.
 */
export class Logger {
  readonly level: LogLevel
  private readonly dir?: string
  private readonly pretty: boolean
  private readonly name: string

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info"
    this.dir = options.dir
    this.pretty = options.pretty ?? true
    this.name = options.name ?? "bridge"
    if (this.dir) ensureDir(this.dir)
  }

  child(name: string): Logger {
    return new Logger({ level: this.level, dir: this.dir, pretty: this.pretty, name: `${this.name}:${name}` })
  }

  debug(message: string, meta?: Meta): void {
    this.write("debug", message, meta)
  }
  info(message: string, meta?: Meta): void {
    this.write("info", message, meta)
  }
  warn(message: string, meta?: Meta): void {
    this.write("warn", message, meta)
  }
  error(message: string, meta?: Meta): void {
    this.write("error", message, meta)
  }

  private write(level: LogLevel, message: string, meta?: Meta): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const record = { ts: timestamp(), level, logger: this.name, message, ...(meta ?? {}) }
    const line = JSON.stringify(record, replacer)
    if (this.pretty) {
      const tag = level.toUpperCase().padEnd(5)
      const extra = meta && Object.keys(meta).length > 0 ? " " + JSON.stringify(meta, replacer) : ""
      process.stdout.write(`${record.ts} ${tag} [${this.name}] ${message}${extra}\n`)
    }
    if (this.dir) {
      try {
        fs.appendFileSync(path.join(this.dir, `app-${today()}.log`), line + "\n", "utf8")
      } catch {
        // never let logging break the app
      }
    }
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (typeof value === "bigint") return value.toString()
  return value
}

/**
 * Append-only audit log for user/system actions (who did what, when).
 * Kept separate from the diagnostic log so it can be retained for compliance.
 */
export class AuditLog {
  private readonly file: string
  constructor(private readonly dir: string) {
    ensureDir(dir)
    this.file = path.join(dir, "audit.jsonl")
  }
  record(event: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: timestamp(), event, ...data })
    try {
      fs.appendFileSync(this.file, line + "\n", "utf8")
    } catch {
      // ignore
    }
  }
}
