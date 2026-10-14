import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Service, type EnsureOptions } from "@opencode/client/service"
import { OpencodeClient } from "./client.js"
import type { OpenCodeConfig } from "../config/index.js"
import type { Logger } from "../util/logger.js"

interface EndpointInfo {
  url: string
  headers: Record<string, string>
}

export interface HealthResult {
  ok: boolean
  info?: { version: string; pid: number; urls: string[] }
  error?: string
}

function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Owns the connection to the OpenCode server: discovery, authentication,
 * health probing and automatic restart.
 */
export class OpencodeService {
  private endpoint?: EndpointInfo
  private clientInstance?: OpencodeClient
  private consecutiveFailures = 0

  constructor(
    private readonly cfg: OpenCodeConfig,
    private readonly logger: Logger,
  ) {}

  /** Resolve the endpoint (discovering or starting the shared service if needed). */
  async resolve(): Promise<EndpointInfo> {
    if (this.endpoint) return this.endpoint
    if (this.cfg.mode === "remote") {
      this.endpoint = {
        url: this.cfg.baseUrl.replace(/\/$/, ""),
        headers: this.cfg.password ? { authorization: basicAuth(this.cfg.password) } : {},
      }
    } else {
      const endpoint = await Service.ensure(this.ensureOptions())
      if (!endpoint) throw new Error("OpenCode service did not return an endpoint")
      this.endpoint = { url: endpoint.url, headers: Service.headers(endpoint) ?? {} }
      this.logger.info("Connected to OpenCode service", {
        url: this.endpoint.url,
        isolated: Boolean(this.cfg.dataDir),
        dataDir: this.cfg.dataDir,
      })
    }
    return this.endpoint
  }

  /** Registration file of the isolated service, when one is configured. */
  private get registrationFile(): string | undefined {
    return this.cfg.dataDir ? path.join(this.cfg.dataDir, "state", "opencode", "service.json") : undefined
  }

  private ensureOptions(): EnsureOptions {
    const command = this.serviceCommand()
    if (this.cfg.dataDir) {
      const root = this.cfg.dataDir
      const stateHome = path.join(root, "state")
      return {
        command,
        file: path.join(stateHome, "opencode", "service.json"),
        env: {
          ...(this.cfg.env ?? {}),
          XDG_DATA_HOME: path.join(root, "share"),
          XDG_STATE_HOME: stateHome,
        },
      }
    }
    return this.cfg.env ? { command, env: { ...this.cfg.env } } : { command }
  }

  private serviceCommand(): string[] {
    const command = resolveServiceCommand([...this.cfg.serviceCommand])
    // An isolated service must not inherit the shared service's fixed port.
    if (this.cfg.dataDir && !command.includes("--port")) {
      command.push("--port", String(this.cfg.servicePort))
    }
    return command
  }

  /** Get (and cache) a client bound to the current endpoint. */
  async client(): Promise<OpencodeClient> {
    if (this.clientInstance) return this.clientInstance
    const endpoint = await this.resolve()
    this.clientInstance = new OpencodeClient({ baseUrl: endpoint.url, headers: endpoint.headers })
    return this.clientInstance
  }

  /** Forget the cached endpoint/client so the next call re-discovers. */
  invalidate(): void {
    this.endpoint = undefined
    this.clientInstance = undefined
  }

  async health(): Promise<HealthResult> {
    try {
      const client = await this.client()
      const info = await withTimeout(client.info(), this.cfg.healthTimeoutMs, "OpenCode health check")
      this.consecutiveFailures = 0
      return { ok: true, info: { version: info.version, pid: info.pid, urls: info.urls } }
    } catch (error) {
      this.consecutiveFailures += 1
      this.invalidate()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Restart the shared background service. Returns true when a restart was
   * attempted (not necessarily successful; the next health check verifies).
   */
  async restart(reason: string): Promise<void> {
    if (!this.cfg.restartOnFailure) {
      this.logger.warn("OpenCode unhealthy but restartOnFailure is disabled", { reason })
      return
    }
    if (this.cfg.mode !== "service") {
      this.logger.warn("OpenCode unhealthy but restart is only supported in service mode", { reason })
      return
    }
    this.logger.warn("Restarting OpenCode service", { reason, failures: this.consecutiveFailures })
    this.invalidate()
    if (this.cfg.dataDir) {
      // Isolated service: stop the registered process and let resolve() respawn it.
      try {
        await Service.stop({ file: this.registrationFile })
        this.logger.info("Isolated OpenCode service stopped; starting a new one")
        await this.resolve()
      } catch (error) {
        this.logger.error("Failed to restart isolated OpenCode service", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    const [command, ...args] = this.cfg.restartCommand
    if (!command) {
      this.logger.error("No restart command configured")
      return
    }
    try {
      await runCommand(command, args)
      this.logger.info("Restart command finished; verifying service")
      // Re-discover a healthy endpoint (starts the service if the restart left it down).
      await this.resolve()
    } catch (error) {
      this.logger.error("Failed to restart OpenCode service", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Number of consecutive failed health checks. */
  get failures(): number {
    return this.consecutiveFailures
  }
}

/**
 * On Windows Node cannot spawn npm's `.cmd`/`.ps1` shims directly, so resolve
 * a bare command to a real `.exe` (on PATH or in the npm global module tree).
 */
function resolveServiceCommand(command: string[]): string[] {
  const [bin, ...rest] = command
  if (!bin || process.platform !== "win32" || path.isAbsolute(bin) || path.extname(bin)) return command

  const candidates: string[] = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, `${bin}.exe`))
  for (const root of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (root) candidates.push(path.join(root, "npm", "node_modules", "@opencode", "cli", "bin", `${bin}.exe`))
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return [candidate, ...rest]
  }
  return command
}

export function runCommand(command: string, args: string[], timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", shell: process.platform === "win32" })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`command timed out: ${command} ${args.join(" ")}`))
    }, timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`command exited with code ${code}: ${command} ${args.join(" ")}`))
    })
  })
}
