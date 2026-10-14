import type { OpenCodeConfig } from "../config/index.js"
import type { OpencodeService } from "../opencode/service.js"
import type { AuditLog, Logger } from "../util/logger.js"

export interface HealthMonitorDeps {
  config: OpenCodeConfig
  service: OpencodeService
  logger: Logger
  audit: AuditLog
  /** Optional alert sink, e.g. send a message to an admin chat. */
  alert?: (message: string) => Promise<void>
}

/**
 * Periodically probes the OpenCode server and restarts the shared service when
 * it stays unhealthy, so the bridge recovers without manual intervention.
 */
export class HealthMonitor {
  private timer?: NodeJS.Timeout
  private healthy = true
  private lastError?: string

  constructor(private readonly deps: HealthMonitorDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.check(), this.deps.config.healthIntervalMs)
    this.timer.unref?.()
    void this.check()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async check(): Promise<boolean> {
    const result = await this.deps.service.health()
    if (result.ok) {
      if (!this.healthy) {
        this.healthy = true
        this.lastError = undefined
        this.deps.logger.info("OpenCode recovered", result.info ? { version: result.info.version } : undefined)
        this.deps.audit.record("opencode.recovered", result.info ?? {})
        await this.safeAlert("✅ OpenCode 已恢复健康。")
      }
      return true
    }

    this.lastError = result.error
    this.deps.logger.warn("OpenCode health check failed", {
      error: result.error,
      failures: this.deps.service.failures,
    })
    if (this.healthy) {
      this.healthy = false
      await this.safeAlert(`⚠️ OpenCode 健康检查失败：${result.error ?? "unknown"}`)
    }
    if (this.deps.service.failures >= this.deps.config.failureThreshold) {
      this.deps.audit.record("opencode.unhealthy", { error: result.error, failures: this.deps.service.failures })
      await this.deps.service.restart(result.error ?? "health check failed")
      // Verify shortly after the restart.
      const after = await this.deps.service.health()
      if (after.ok) {
        this.healthy = true
        await this.safeAlert("♻️ OpenCode 已自动重启并恢复。")
      } else {
        await this.safeAlert(`❌ OpenCode 自动重启后仍不可用：${after.error ?? "unknown"}`)
      }
    }
    return false
  }

  private async safeAlert(message: string): Promise<void> {
    if (!this.deps.alert) return
    try {
      await this.deps.alert(message)
    } catch (error) {
      this.deps.logger.debug("Failed to send health alert", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  get isHealthy(): boolean {
    return this.healthy
  }
}
