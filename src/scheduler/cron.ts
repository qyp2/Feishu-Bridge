import { Cron } from "croner"
import path from "node:path"
import type { AppConfig, CronJobConfig } from "../config/index.js"
import type { ConversationService, ChatIdentity } from "../core/conversations.js"
import type { CronController, CronJobInfo } from "../core/commands.js"
import type { FeishuBot } from "../feishu/bot.js"
import type { AuditLog, Logger } from "../util/logger.js"
import { readJson, writeJson } from "../util/jsonfile.js"
import { markdownCard, statusCard } from "../feishu/cards.js"
import { isProgressShell } from "../core/turn.js"

interface ScheduledJob {
  config: CronJobConfig
  cron: Cron
  pregenTimer?: NodeJS.Timeout
}

/** Pre-generated reply waiting for its delivery instant. */
interface PregenResult {
  text: string
  forRunAt: number
}

/** Run the agent this long before the delivery instant, so the answer is ready. */
const PRE_GEN_LEAD_MS = 15 * 60_000
/** Below this gap the agent cannot finish in time — run live instead. */
const PRE_GEN_MIN_GAP_MS = 90_000
/**
 * At the delivery instant, wait this long for a still-running pre-generation
 * to finish before falling back to a live run — otherwise the user watches the
 * agent start generating at the exact minute the answer should already arrive.
 */
const PREGEN_WAIT_MS = 3 * 60_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 固定文字模版用法提示（订阅入口为纯文字句式，非快捷键） */
const ADD_USAGE =
  "订阅请用固定格式：**订阅 <频率> <时间> <内容>**\n" +
  "- 频率：每天 / 每工作日 / 每周一~日 / 每月N号\n" +
  "- 时间：24 小时制，如 9:00、18:30 或 9点30\n" +
  "- 例：「订阅 每周一 9:00 FTTR 相关资讯」「订阅 每天 8:30 香港教育产品动向」\n" +
  "也可以点击下方菜单「订阅 > 资讯订阅」，点选创建。"

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
  /** Paused jobs keep their config (and persistence) but have no live timer. */
  private readonly pausedJobs = new Map<string, CronJobConfig>()
  private readonly pregenCache = new Map<string, PregenResult>()
  /** Pre-generation promises in flight, so delivery can await them instead of re-running. */
  private readonly pregenInflight = new Map<string, Promise<void>>()
  private readonly file: string
  /** Pre-generated results survive tsx-watch reloads: cached on disk, consumed on delivery. */
  private readonly pregenFile: string

  constructor(private readonly deps: CronDeps) {
    this.file = path.join(deps.storageDir, "cron.json")
    this.pregenFile = path.join(deps.storageDir, "cron-pregen.json")
  }

  start(): void {
    // Reload cached pre-generation results; entries whose delivery instant is
    // already past are useless (a stale answer must never be delivered).
    const saved = readJson<Record<string, PregenResult>>(this.pregenFile, {})
    const now = Date.now()
    for (const [name, result] of Object.entries(saved)) {
      if (result && typeof result.text === "string" && result.forRunAt > now) {
        this.pregenCache.set(name, result)
      }
    }
    const persisted = readJson<CronJobConfig[]>(this.file, [])
    const all = [...this.deps.config.cron, ...persisted]
    for (const job of all) this.schedule(job)
    this.deps.logger.info("Cron scheduler started", { jobs: this.jobs.size, pregenCached: this.pregenCache.size })
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.cron.stop()
      if (job.pregenTimer) clearTimeout(job.pregenTimer)
    }
    this.jobs.clear()
    this.pregenCache.clear()
  }

  private schedule(job: CronJobConfig): void {
    if (!job.enabled) {
      this.pausedJobs.set(job.name, job)
      return
    }
    if (this.jobs.has(job.name)) {
      this.deps.logger.warn("Duplicate cron job name ignored", { name: job.name })
      return
    }
    try {
      const cron = new Cron(job.schedule, { name: job.name, protect: true }, () => void this.execute(job))
      const entry: ScheduledJob = { config: job, cron }
      this.jobs.set(job.name, entry)
      this.armPregen(job, entry)
      this.deps.logger.info("Cron job scheduled", { name: job.name, schedule: job.schedule, next: cron.nextRun()?.toISOString() })
    } catch (error) {
      this.deps.logger.error("Failed to schedule cron job", { name: job.name, error: message(error) })
    }
  }

  /** Schedule the silent pre-generation one lead-time before the next run. */
  private armPregen(job: CronJobConfig, entry: ScheduledJob): void {
    if (entry.pregenTimer) clearTimeout(entry.pregenTimer)
    const next = entry.cron.nextRun()
    if (!next) return
    const untilRun = next.getTime() - Date.now()
    const delay = untilRun - PRE_GEN_LEAD_MS
    if (delay > 0) {
      entry.pregenTimer = setTimeout(() => void this.pregen(job.name), delay)
      return
    }
    // Already inside the lead window (e.g. a subscription created minutes
    // before its run): pregenerate right away, as long as the agent still
    // has time to finish before the delivery instant.
    if (untilRun > PRE_GEN_MIN_GAP_MS) void this.pregen(job.name)
  }

  private async pregen(name: string): Promise<void> {
    const entry = this.jobs.get(name)
    if (!entry) return
    // Re-entry (reload re-arm, manual trigger): join the run already in flight
    // instead of starting a second agent session for the same job.
    const existing = this.pregenInflight.get(name)
    if (existing) return existing
    const job = entry.config
    const bot = this.deps.conversations.getBot(job.bot)
    if (!bot) return
    // Capture the target run up front: a pregen finishing after the delivery
    // instant would otherwise stamp the cache with the *next* occurrence.
    const forRunAt = entry.cron.nextRun()?.getTime() ?? 0
    const run = (async () => {
      try {
        this.deps.audit.record("cron.pregen.start", { name })
        let text = await this.deps.conversations.pregenerate(bot, job.chatId, job.prompt, job.userId, job.ownerOpenId)
        if (!text || isProgressShell(text)) {
          // One retry. The first run can still come back empty if the agent
          // never wrote; delivering that is worse than spending another turn.
          this.deps.audit.record("cron.pregen.retry", { name })
          text = await this.deps.conversations.pregenerate(bot, job.chatId, job.prompt, job.userId, job.ownerOpenId)
        }
        if (text && !isProgressShell(text)) {
          this.pregenCache.set(name, { text, forRunAt })
          this.persistPregen()
          this.deps.audit.record("cron.pregen.ok", { name, chars: text.length })
        } else {
          this.deps.audit.record("cron.pregen.empty", { name })
        }
      } catch (error) {
        this.deps.logger.warn("Cron pre-generation failed", { name, error: message(error) })
        this.deps.audit.record("cron.pregen.error", { name, error: message(error) })
      }
    })()
    this.pregenInflight.set(name, run)
    try {
      await run
    } finally {
      this.pregenInflight.delete(name)
    }
  }

  private persistPregen(): void {
    writeJson(this.pregenFile, Object.fromEntries(this.pregenCache))
  }

  /** Consume a pre-generated result, only if it is fresh enough for this run. */
  private takePregen(name: string): PregenResult | undefined {
    const cached = this.pregenCache.get(name)
    if (!cached) return undefined
    this.pregenCache.delete(name)
    this.persistPregen()
    if (!cached.text.trim() || isProgressShell(cached.text)) return undefined
    // Stamped for a run too far in the past (schedule edited, process slept):
    // deliver nothing stale.
    if (cached.forRunAt < Date.now() - PRE_GEN_LEAD_MS) return undefined
    return cached
  }

  /**
   * Silent runs until there is a real answer. The streaming progress card is
   * never opened, so a turn that closes early cannot push 「处理完成」.
   */
  private async generateUntilAnswer(bot: FeishuBot, job: CronJobConfig): Promise<string | undefined> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.deps.audit.record("cron.deliver.retry", { name: job.name, attempt })
      const text = await this.deps.conversations.pregenerate(bot, job.chatId, job.prompt, job.userId, job.ownerOpenId)
      if (text && !isProgressShell(text)) return text
    }
    return undefined
  }

  /** In-app urgent reminder after delivery; never blocks or breaks delivery. */
  private async urgentIfWanted(bot: FeishuBot, job: CronJobConfig, messageId?: string): Promise<void> {
    const target = job.ownerOpenId ?? job.userId
    if (job.urgent === false || !messageId || !target) return
    try {
      await bot.urgentApp(messageId, [target])
      this.deps.audit.record("cron.urgent", { name: job.name, messageId })
    } catch (error) {
      this.deps.logger.warn("Cron urgent reminder failed", { name: job.name, error: message(error) })
    }
  }

  private async execute(job: CronJobConfig): Promise<void> {
    const bot = this.deps.conversations.getBot(job.bot)
    if (!bot) {
      this.deps.logger.warn("Cron job references unknown bot", { name: job.name, bot: job.bot })
      return
    }
    this.deps.audit.record("cron.run", { name: job.name, bot: job.bot, chatId: job.chatId })
    const entry = this.jobs.get(job.name)
    try {
      let cached = this.takePregen(job.name)
      if (!cached) {
        // Pre-generation still running (compressed window or a slow agent):
        // give it a bounded wait — delivering two minutes late beats making the
        // user watch a fresh live run that duplicates the in-flight one.
        const inflight = this.pregenInflight.get(job.name)
        if (inflight) {
          this.deps.audit.record("cron.pregen.wait", { name: job.name })
          await Promise.race([inflight, sleep(PREGEN_WAIT_MS)])
          cached = this.takePregen(job.name)
        }
      }
      const text = cached?.text ?? (await this.generateUntilAnswer(bot, job))
      if (text) {
        // One card, and only the answer. Never the live progress shell
        // (处理完成 / 解读指令) — that shell is what went out at 09:00.
        const sent = await bot.sendCard(job.chatId, markdownCard(`⏰ 资讯订阅 · ${job.name}`, text))
        await this.urgentIfWanted(bot, job, sent?.messageId)
        this.deps.audit.record(cached ? "cron.delivered_pregen" : "cron.delivered_live", {
          name: job.name,
          chars: text.length,
        })
      } else {
        const sent = await bot.sendCard(
          job.chatId,
          statusCard(
            `⏰ 资讯订阅 · ${job.name}`,
            "这次没有生成出订阅内容（模型没有返回正文）。订阅仍然有效，下一轮会照常推送。",
            "orange",
          ),
        )
        await this.urgentIfWanted(bot, job, sent?.messageId)
        this.deps.audit.record("cron.delivered_empty", { name: job.name })
      }
    } catch (error) {
      this.deps.logger.error("Cron job failed", { name: job.name, error: message(error) })
      this.deps.audit.record("cron.error", { name: job.name, error: message(error) })
      await bot
        .sendCard(
          job.chatId,
          statusCard(
            `⏰ 资讯订阅 · ${job.name}`,
            `这次订阅没有发出正文：${message(error)}。订阅仍然有效，下一轮会照常推送。`,
            "orange",
          ),
        )
        .catch(() => {})
    } finally {
      // Re-arm the silent pre-generation for the next scheduled run.
      if (entry) this.armPregen(job, entry)
    }
  }

  private persist(): void {
    const runtime = [...this.jobs.values()].map((j) => j.config)
    runtime.push(...this.pausedJobs.values())
    // only persist jobs that are not declared in the config file
    writeJson(this.file, runtime.filter((job) => !this.deps.config.cron.some((c) => c.name === job.name)))
  }

  /** Toggle the post-delivery urgent reminder. Returns the new urgent state. */
  toggleUrgent(name: string): boolean | undefined {
    const config = this.jobs.get(name)?.config ?? this.pausedJobs.get(name)
    if (!config) return undefined
    config.urgent = config.urgent === false
    this.persist()
    this.deps.audit.record(config.urgent ? "cron.urgent_on" : "cron.urgent_off", { name })
    return config.urgent
  }

  /** Structured view for the management card. */
  list(): CronJobInfo[] {
    const active = [...this.jobs.values()].map((j) => ({
      name: j.config.name,
      schedule: j.config.schedule,
      prompt: j.config.prompt,
      enabled: true,
      urgent: j.config.urgent !== false,
      next: j.cron.nextRun()?.toLocaleString(),
      chatId: j.config.chatId,
      ownerOpenId: j.config.ownerOpenId,
    }))
    const paused = [...this.pausedJobs.values()].map((c) => ({
      name: c.name,
      schedule: c.schedule,
      prompt: c.prompt,
      enabled: false,
      urgent: c.urgent !== false,
      next: undefined,
      chatId: c.chatId,
      ownerOpenId: c.ownerOpenId,
    }))
    return [...active, ...paused]
  }

  listFor(openId: string, chatId: string): CronJobInfo[] {
    return this.list().filter((job) => job.ownerOpenId === openId || (!job.ownerOpenId && job.chatId === chatId))
  }

  /** Pause an active job or resume a paused one. Returns the new enabled state. */
  togglePause(name: string): boolean | undefined {
    const active = this.jobs.get(name)
    if (active) {
      active.cron.stop()
      if (active.pregenTimer) clearTimeout(active.pregenTimer)
      this.pregenCache.delete(name)
      this.persistPregen()
      this.jobs.delete(name)
      this.pausedJobs.set(name, { ...active.config, enabled: false })
      this.persist()
      this.deps.audit.record("cron.paused", { name })
      return false
    }
    const paused = this.pausedJobs.get(name)
    if (paused) {
      this.pausedJobs.delete(name)
      this.schedule({ ...paused, enabled: true })
      this.persist()
      this.deps.audit.record("cron.resumed", { name })
      return true
    }
    return undefined
  }

  describe(): string {
    const entries = [...this.jobs.values()]
    const paused = [...this.pausedJobs.values()]
    if (entries.length === 0 && paused.length === 0)
      return "暂无订阅。\n点击下方菜单「订阅 > 资讯订阅」，点选频率、时间和内容即可创建。"
    const lines = entries.map((j) => {
      const next = j.cron.nextRun()
      return `- **${j.config.name}** \`${j.config.schedule}\` → ${j.config.chatId}${next ? `\n 下次：${next.toLocaleString()}` : ""}\n 提示词：${j.config.prompt.slice(0, 60)}`
    })
    for (const c of paused) lines.push(`- **${c.name}** \`${c.schedule}\`（已暂停）\n 提示词：${c.prompt.slice(0, 60)}`)
    return lines.join("\n")
  }

  async add(args: string[], identity: ChatIdentity, botName: string): Promise<string> {
    const name = args[0]
    if (!name) return ADD_USAGE
    const scheduleTokens = args.slice(1, 6)
    const prompt = args.slice(6).join(" ")
    if (scheduleTokens.length < 5 || !prompt) {
      return ADD_USAGE
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
      ownerOpenId: identity.senderId,
      urgent: true,
      enabled: true,
    }
    const existing = this.jobs.get(name)
    if (existing) {
      existing.cron.stop()
      if (existing.pregenTimer) clearTimeout(existing.pregenTimer)
    }
    this.jobs.delete(name)
    this.pausedJobs.delete(name) // replacing a paused job revives it as enabled
    this.pregenCache.delete(name)
    this.persistPregen()
    this.schedule(job)
    this.persist()
    this.deps.audit.record("cron.added", { name, schedule, bot: botName, chatId: identity.chatId })
    return `✅ 已订阅 **${name}**（\`${schedule}\`）。\n点击下方菜单「订阅 > 我的订阅」可查看、暂停、编辑或删除。`
  }

  async remove(name: string): Promise<string> {
    const job = this.jobs.get(name)
    if (job) {
      job.cron.stop()
      if (job.pregenTimer) clearTimeout(job.pregenTimer)
      this.jobs.delete(name)
      this.pregenCache.delete(name)
      this.persistPregen()
      this.persist()
      this.deps.audit.record("cron.removed", { name })
      return `已删除定时任务 **${name}**`
    }
    if (this.pausedJobs.delete(name)) {
      this.persist()
      this.deps.audit.record("cron.removed", { name, paused: true })
      return `已删除定时任务 **${name}**`
    }
    return `未找到定时任务：${name}`
  }

  async run(name: string): Promise<string> {
    const job = this.jobs.get(name)
    const config = job?.config ?? this.pausedJobs.get(name)
    if (!config) return `未找到定时任务：${name}`
    void this.execute(config)
    return `已触发定时任务 **${name}**`
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
