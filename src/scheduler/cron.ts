import { Cron } from "croner"
import path from "node:path"
import type { AppConfig, CronJobConfig } from "../config/index.js"
import type { ConversationService, ChatIdentity } from "../core/conversations.js"
import type { CronController } from "../core/commands.js"
import type { AuditLog, Logger } from "../util/logger.js"
import { readJson, writeJson } from "../util/jsonfile.js"

interface ScheduledJob {
  config: CronJobConfig
  cron: Cron
}

export interface CronDeps {
  config: AppConfig
  conversations: ConversationService
  logger: Logger
  audit: AuditLog
  storageDir: string
}

/**
 * Dynamic cron scheduler. Jobs come from configuration and can also be added,
 * removed or triggered at runtime by chat users; runtime jobs are persisted.
 */
export class CronManager implements CronController {
  private readonly jobs = new Map<string, ScheduledJob>()
  private readonly file: string

  constructor(private readonly deps: CronDeps) {
    this.file = path.join(deps.storageDir, "cron.json")
  }

  start(): void {
    const persisted = readJson<CronJobConfig[]>(this.file, [])
    const all = [...this.deps.config.cron, ...persisted]
    for (const job of all) this.schedule(job)
    this.deps.logger.info("Cron scheduler started", { jobs: this.jobs.size })
  }

  stop(): void {
    for (const job of this.jobs.values()) job.cron.stop()
    this.jobs.clear()
  }

  private schedule(job: CronJobConfig): void {
    if (!job.enabled) return
    if (this.jobs.has(job.name)) {
      this.deps.logger.warn("Duplicate cron job name ignored", { name: job.name })
      return
    }
    try {
      const cron = new Cron(job.schedule, { name: job.name, protect: true }, () => void this.execute(job))
      this.jobs.set(job.name, { config: job, cron })
      this.deps.logger.info("Cron job scheduled", { name: job.name, schedule: job.schedule, next: cron.nextRun()?.toISOString() })
    } catch (error) {
      this.deps.logger.error("Failed to schedule cron job", { name: job.name, error: message(error) })
    }
  }

  private async execute(job: CronJobConfig): Promise<void> {
    const bot = this.deps.conversations.getBot(job.bot)
    if (!bot) {
      this.deps.logger.warn("Cron job references unknown bot", { name: job.name, bot: job.bot })
      return
    }
    this.deps.audit.record("cron.run", { name: job.name, bot: job.bot, chatId: job.chatId })
    try {
      await this.deps.conversations.runScheduled(bot, job.chatId, job.prompt, job.userId)
    } catch (error) {
      this.deps.logger.error("Cron job failed", { name: job.name, error: message(error) })
      this.deps.audit.record("cron.error", { name: job.name, error: message(error) })
    }
  }

  private persist(): void {
    const runtime = [...this.jobs.values()]
      .map((j) => j.config)
      // only persist jobs that are not declared in the config file
      .filter((job) => !this.deps.config.cron.some((c) => c.name === job.name))
    writeJson(this.file, runtime)
  }

  describe(): string {
    const entries = [...this.jobs.values()]
    if (entries.length === 0) return "暂无定时任务。\n用法：/cron add <名称> <cron表达式> <提示词>"
    return entries
      .map((j) => {
        const next = j.cron.nextRun()
        return `- **${j.config.name}** \`${j.config.schedule}\` → ${j.config.chatId}${next ? `\n 下次：${next.toLocaleString()}` : ""}\n 提示词：${j.config.prompt.slice(0, 60)}`
      })
      .join("\n")
  }

  async add(args: string[], identity: ChatIdentity, botName: string): Promise<string> {
    const name = args[0]
    if (!name) return "用法：/cron add <名称> <分 时 日 月 周> <提示词>"
    const scheduleTokens = args.slice(1, 6)
    const prompt = args.slice(6).join(" ")
    if (scheduleTokens.length < 5 || !prompt) {
      return "用法：/cron add <名称> <分 时 日 月 周> <提示词>"
    }
    const schedule = scheduleTokens.join(" ")
    try {
      // Validate the expression before persisting.
      const probe = new Cron(schedule, { paused: true })
      probe.stop()
    } catch {
      return `无效的 cron 表达式：${schedule}`
    }
    const job: CronJobConfig = {
      name,
      bot: botName,
      schedule,
      chatId: identity.chatId,
      prompt,
      userId: identity.chatType === "group" ? identity.senderId : undefined,
      enabled: true,
    }
    const existing = this.jobs.get(name)
    if (existing) existing.cron.stop()
    this.jobs.delete(name)
    this.schedule(job)
    this.persist()
    this.deps.audit.record("cron.added", { name, schedule, bot: botName, chatId: identity.chatId })
    return `已添加定时任务 **${name}**：\`${schedule}\``
  }

  async remove(name: string): Promise<string> {
    const job = this.jobs.get(name)
    if (!job) return `未找到定时任务：${name}`
    job.cron.stop()
    this.jobs.delete(name)
    this.persist()
    this.deps.audit.record("cron.removed", { name })
    return `已删除定时任务 **${name}**`
  }

  async run(name: string): Promise<string> {
    const job = this.jobs.get(name)
    if (!job) return `未找到定时任务：${name}`
    void this.execute(job.config)
    return `已触发定时任务 **${name}**`
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
