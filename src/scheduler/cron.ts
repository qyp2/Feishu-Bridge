import { Cron } from "croner"
import path from "node:path"
import type { AppConfig, CronJobConfig } from "../config/index.js"
import type { ConversationService, ChatIdentity } from "../core/conversations.js"
import { MAIL_CRON_EXEC_APPENDIX, type CronController, type CronJobInfo } from "../core/commands.js"
import type { FeishuBot } from "../feishu/bot.js"
import type { AuditLog, Logger } from "../util/logger.js"
import { KeyedSerial, Semaphore } from "../util/async.js"
import { readJson, writeJson } from "../util/jsonfile.js"
import { isMailJob, markdownCard, statusCard } from "../feishu/cards.js"
import { IntelArchiveStore, parseIntelReport } from "../intel/archive.js"
import { INTEL_QUIET_NOTICE, intelDigestCard } from "../intel/cards.js"
import { isProgressShell } from "../core/turn.js"
import type { MailBindingStore } from "../mail/binding.js"

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
 * A digest may leave only during this window after the scheduled instant.
 * Anything that finishes later is dropped, so a slow run cannot push into the
 * chat after the minute, or after the user has already moved the schedule.
 */
const ON_TIME_MS = 60_000
/** Shorter answers are usually agent refusals, not a mail digest. */
const MIN_MAIL_DIGEST_CHARS = 80

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
  getMailBinding?: () => MailBindingStore | undefined
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
  /** Epoch captured by the in-flight pre-generation, so a reschedule does not join the old run. */
  private readonly pregenEpoch = new Map<string, number>()
  /**
   * Incremented when a job is edited, paused, or removed. An in-flight run
   * keeps the epoch it started with and must not send after this moves.
   */
  private readonly deliveryEpoch = new Map<string, number>()
  /** One agent chain per subscriber/job; mail digests share a bounded concurrency pool. */
  private readonly agentQueue = new KeyedSerial()
  private readonly mailDigestPool: Semaphore
  private readonly file: string
  /** Pre-generated results survive tsx-watch reloads: cached on disk, consumed on delivery. */
  private readonly pregenFile: string
  /** Seen links, exclusions and the last digest, for 资讯订阅 only. */
  readonly intel: IntelArchiveStore

  constructor(private readonly deps: CronDeps) {
    this.file = path.join(deps.storageDir, "cron.json")
    this.intel = new IntelArchiveStore(deps.storageDir)
    this.pregenFile = path.join(deps.storageDir, "cron-pregen.json")
    const max = deps.config.mail.digestConcurrency
    this.mailDigestPool = new Semaphore(max)
  }

  start(): void {
    // Reload cached pre-generation results; entries whose delivery instant is
    // already past are useless (a stale answer must never be delivered).
    const saved = readJson<Record<string, PregenResult>>(this.pregenFile, {})
    const now = Date.now()
    for (const [name, result] of Object.entries(saved)) {
      if (!result || typeof result.text !== "string" || result.forRunAt <= now) continue
      const job = [...this.deps.config.cron, ...readJson<CronJobConfig[]>(this.file, [])].find((j) => j.name === name)
      if (job && isMailJob(job) && result.text.trim().length < MIN_MAIL_DIGEST_CHARS) continue
      this.pregenCache.set(name, result)
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
    if (isMailJob(job) && !this.mailJobReady(job)) {
      this.pauseUnboundMailJob(job)
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
    const jitter = isMailJob(job) ? this.mailPregenJitter(job, untilRun) : 0
    if (delay > 0) {
      entry.pregenTimer = setTimeout(() => void this.pregen(job.name), delay + jitter)
      return
    }
    // Already inside the lead window (e.g. a subscription created minutes
    // before its run): pregenerate right away, as long as the agent still
    // has time to finish before the delivery instant.
    if (untilRun > PRE_GEN_MIN_GAP_MS) {
      entry.pregenTimer = setTimeout(() => void this.pregen(job.name), jitter)
    }
  }

  /** Spread mail pregens across the lead window so 80+ subscribers do not stampede. */
  private mailPregenJitter(job: CronJobConfig, untilRunMs: number): number {
    const span = Math.max(0, Math.min(PRE_GEN_LEAD_MS, untilRunMs - PRE_GEN_MIN_GAP_MS))
    if (span <= 0) return 0
    const id = job.ownerOpenId?.trim() || job.name
    let hash = 2166136261
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
    return Math.abs(hash >>> 0) % span
  }

  /** Mail cron runs only when this subscriber has bound a mailbox in Bridge. */
  private mailJobReady(job: CronJobConfig): boolean {
    if (!isMailJob(job)) return true
    const openId = job.ownerOpenId?.trim()
    if (!openId) return false
    const bound = this.deps.getMailBinding?.()?.get(openId)
    return Boolean(bound?.email?.includes("@"))
  }

  private skipMailJob(job: CronJobConfig, phase: "pregen" | "run"): boolean {
    if (this.mailJobReady(job)) return false
    this.deps.audit.record("cron.mail.skipped", {
      name: job.name,
      phase,
      chatId: job.chatId,
      ownerOpenId: job.ownerOpenId,
      reason: "mailbox_not_bound",
    })
    return true
  }

  /** Unbound mail jobs stay in cron.json but never arm timers or pregen. */
  private pauseUnboundMailJob(job: CronJobConfig): void {
    const active = this.jobs.get(job.name)
    if (active) {
      active.cron.stop()
      if (active.pregenTimer) clearTimeout(active.pregenTimer)
      this.invalidateDelivery(job.name)
      this.jobs.delete(job.name)
    }
    this.pregenCache.delete(job.name)
    this.persistPregen()
    const paused = { ...job, enabled: false }
    this.pausedJobs.set(job.name, paused)
    this.persist()
    this.deps.audit.record("cron.mail.disabled", {
      name: job.name,
      chatId: job.chatId,
      ownerOpenId: job.ownerOpenId,
      reason: "mailbox_not_bound",
    })
  }

  /** After mailbox bind, re-enable mail crons that were auto-paused for this user. */
  resumeMailJobsForOwner(openId: string): void {
    const trimmed = openId.trim()
    if (!trimmed) return
    for (const config of [...this.pausedJobs.values()]) {
      if (config.ownerOpenId !== trimmed || !isMailJob(config)) continue
      if (!this.mailJobReady({ ...config, enabled: true })) continue
      this.pausedJobs.delete(config.name)
      this.schedule({ ...config, enabled: true })
      this.deps.audit.record("cron.mail.resumed", { name: config.name, ownerOpenId: trimmed })
    }
    this.persist()
  }

  private agentQueueKey(job: CronJobConfig): string {
    if (isMailJob(job)) {
      const owner = job.ownerOpenId?.trim() || job.name
      return `mail-cron:${owner}`
    }
    return `cron:${job.name}`
  }

  private async produceDigest(job: CronJobConfig, bot: FeishuBot, maxAttempts: number): Promise<string | undefined> {
    const prompt = this.promptForJob(job)
    // 资讯订阅走 A81+S82；邮件订阅走 A64+S64（禁止落到 pm-brain，否则调不了 mail.mjs）。
    const agent = isMailJob(job) ? "pm-a64-mail" : "pm-a81-opportunity"
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        this.deps.audit.record("cron.agent.retry", { name: job.name, attempt })
      }
      const { text, paused } = await this.deps.conversations.pregenerate(
        bot,
        job.chatId,
        prompt,
        job.userId,
        job.ownerOpenId,
        agent ? { agent } : undefined,
      )
      if (paused) return undefined
      if (this.usableDigest(text, job)) return text
    }
    return undefined
  }

  private queuedDigest(job: CronJobConfig, bot: FeishuBot, maxAttempts: number): Promise<string | undefined> {
    const key = this.agentQueueKey(job)
    const digest = () => this.produceDigest(job, bot, maxAttempts)
    if (!isMailJob(job)) return this.agentQueue.run(key, digest)
    return this.agentQueue.run(key, () => this.runMailDigestWithPool(job, digest))
  }

  private runMailDigestWithPool(
    job: CronJobConfig,
    digest: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const queued = this.mailDigestPool.waiting
    if (queued > 0) {
      this.deps.audit.record("cron.mail.pool_wait", {
        name: job.name,
        ownerOpenId: job.ownerOpenId,
        queued,
        inUse: this.mailDigestPool.inUse,
      })
    }
    return this.mailDigestPool.run(digest)
  }

  private promptForJob(job: CronJobConfig): string {
    if (isMailJob(job)) {
      if (job.prompt.includes("【定时邮件订阅 · Bridge 执行说明】")) return job.prompt
      return `${job.prompt}\n${MAIL_CRON_EXEC_APPENDIX}`
    }
    return `${job.prompt}\n\n${this.intel.promptBlock(job.name)}`
  }

  private usableDigest(text: string | undefined, job: CronJobConfig): text is string {
    if (!text || isProgressShell(text)) return false
    if (isMailJob(job) && text.trim().length < MIN_MAIL_DIGEST_CHARS) return false
    return true
  }

  /** Drop any in-flight send. The run that is already generating keeps going, but it cannot deliver. */
  private invalidateDelivery(name: string): void {
    this.deliveryEpoch.set(name, (this.deliveryEpoch.get(name) ?? 0) + 1)
  }

  private async pregen(name: string): Promise<void> {
    const entry = this.jobs.get(name)
    if (!entry) return
    const job = entry.config
    if (this.skipMailJob(job, "pregen")) return
    const epoch = this.deliveryEpoch.get(name) ?? 0
    // Re-entry for the same schedule joins the run already in flight.
    // A reschedule has a new epoch and must start its own side session.
    const existing = this.pregenInflight.get(name)
    if (existing && this.pregenEpoch.get(name) === epoch) return existing
    const bot = this.deps.conversations.getBot(job.bot)
    if (!bot) return
    // Capture the target run up front: a pregen finishing after the delivery
    // instant would otherwise stamp the cache with the *next* occurrence.
    const forRunAt = entry.cron.nextRun()?.getTime() ?? 0
    const run = (async () => {
      try {
        this.deps.audit.record("cron.pregen.start", { name })
        const text = await this.queuedDigest(job, bot, 2)
        if ((this.deliveryEpoch.get(name) ?? 0) !== epoch) {
          this.deps.audit.record("cron.pregen.dropped", { name, reason: "rescheduled" })
          return
        }
        if (!forRunAt || Date.now() > forRunAt + ON_TIME_MS) {
          this.deps.audit.record("cron.pregen.dropped", { name, reason: "late" })
          return
        }
        if (this.usableDigest(text, job)) {
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
    this.pregenEpoch.set(name, epoch)
    try {
      await run
    } finally {
      if (this.pregenInflight.get(name) === run) this.pregenInflight.delete(name)
    }
  }

  private persistPregen(): void {
    writeJson(this.pregenFile, Object.fromEntries(this.pregenCache))
  }

  /** Consume a pre-generated result only when it was stamped for this firing. */
  private takePregen(name: string, firedAt: number): PregenResult | undefined {
    const cached = this.pregenCache.get(name)
    if (!cached) return undefined
    const job = this.jobs.get(name)?.config ?? this.pausedJobs.get(name)
    const forThisSlot = Math.abs(cached.forRunAt - firedAt) <= ON_TIME_MS
    const usable =
      forThisSlot &&
      cached.text.trim().length > 0 &&
      !isProgressShell(cached.text) &&
      !(job && isMailJob(job) && cached.text.trim().length < MIN_MAIL_DIGEST_CHARS)
    if (!usable) {
      this.pregenCache.delete(name)
      this.persistPregen()
      return undefined
    }
    this.pregenCache.delete(name)
    this.persistPregen()
    return cached
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
    if (this.skipMailJob(job, "run")) return
    this.deps.audit.record("cron.run", { name: job.name, bot: job.bot, chatId: job.chatId })
    const entry = this.jobs.get(job.name)
    const firedAt = Date.now()
    const epoch = this.deliveryEpoch.get(job.name) ?? 0
    const stillOnTime = () =>
      (this.deliveryEpoch.get(job.name) ?? 0) === epoch && Date.now() - firedAt <= ON_TIME_MS
    try {
      // The side session is supposed to have finished before this minute.
      // Wait out only the rest of the minute; never start another generation
      // here, and never send once the minute (or the schedule) has moved on.
      let cached = this.takePregen(job.name, firedAt)
      if (!cached) {
        const inflight = this.pregenInflight.get(job.name)
        const left = ON_TIME_MS - (Date.now() - firedAt)
        if (inflight && left > 0) {
          this.deps.audit.record("cron.pregen.wait", { name: job.name })
          await Promise.race([inflight, sleep(left)])
          if (stillOnTime()) cached = this.takePregen(job.name, firedAt)
        }
      }
      if (!stillOnTime()) {
        this.deps.audit.record("cron.deliver.skipped", { name: job.name, reason: "off_slot" })
        return
      }
      const text = cached?.text
      if (text) {
        const intel = isMailJob(job) ? undefined : await this.deliverIntel(bot, job, text)
        if (intel) {
          await this.urgentIfWanted(bot, job, intel.messageId)
          this.deps.audit.record(intel.kind, { name: job.name, count: intel.count, chars: text.length })
        } else {
          // One card, and only the answer. Never the live progress shell
          // (处理完成 / 解读指令) — that shell is what went out at 09:00.
          const sent = await bot.sendCard(job.chatId, markdownCard(`⏰ 资讯订阅 · ${job.name}`, text))
          await this.urgentIfWanted(bot, job, sent?.messageId)
          this.deps.audit.record(cached ? "cron.delivered_pregen" : "cron.delivered_live", {
            name: job.name,
            chars: text.length,
          })
        }
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
      if (!stillOnTime()) return
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
      // Re-arm only if this schedule is still the live one. An edit replaces
      // the entry and arms its own pre-generation.
      if (entry && this.jobs.get(job.name) === entry) this.armPregen(job, entry)
    }
  }

  /**
   * 资讯订阅：解析增量条目。没有新条目就发一行说明。
   * 模型没按档案格式交卷时返回 undefined，调用方仍走原来的正文卡。
   */
  private async deliverIntel(
    bot: FeishuBot,
    job: CronJobConfig,
    text: string,
  ): Promise<{ messageId?: string; kind: string; count: number } | undefined> {
    const report = parseIntelReport(text)
    if (report.kind === "legacy") return undefined
    const fresh = report.kind === "items" ? this.intel.preview(job.name, report.items) : []
    const nextLabel = formatNext(this.jobs.get(job.name)?.cron.nextRun())
    if (fresh.length === 0) {
      // 零增量：只发一句提示，不发空卡片。
      const sent = await bot.sendText(job.chatId, INTEL_QUIET_NOTICE)
      this.intel.markRun(job.name, 0)
      return { messageId: sent?.messageId, kind: "cron.intel_empty", count: 0 }
    }
    const sent = await bot.sendCard(job.chatId, intelDigestCard(job.name, fresh, nextLabel))
    this.intel.commit(job.name, fresh)
    this.intel.markRun(job.name, fresh.length)
    if (sent?.messageId) this.intel.rememberDelivery(job.name, sent.messageId, fresh.map((item) => item.id), nextLabel)
    return { messageId: sent?.messageId, kind: "cron.intel", count: fresh.length }
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

  find(name: string): (CronJobInfo & { bot: string; userId?: string }) | undefined {
    const active = this.jobs.get(name)
    const config = active?.config ?? this.pausedJobs.get(name)
    if (!config) return undefined
    return {
      name: config.name,
      schedule: config.schedule,
      prompt: config.prompt,
      enabled: Boolean(active),
      urgent: config.urgent !== false,
      next: active?.cron.nextRun()?.toLocaleString(),
      chatId: config.chatId,
      ownerOpenId: config.ownerOpenId,
      bot: config.bot,
      userId: config.userId,
    }
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
      this.invalidateDelivery(name)
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
    this.invalidateDelivery(name)
    this.pregenCache.delete(name)
    this.persistPregen()
    this.schedule(job)
    this.persist()
    this.deps.audit.record("cron.added", { name, schedule, bot: botName, chatId: identity.chatId })
    return `✅ 已订阅 **${name}**（\`${schedule}\`）。\n点击下方菜单「订阅 > 我的订阅」可查看、暂停、编辑或删除。`
  }

  async remove(name: string, options?: { keepIntel?: boolean }): Promise<string> {
    const keepIntel = Boolean(options?.keepIntel)
    const job = this.jobs.get(name)
    if (job) {
      job.cron.stop()
      if (job.pregenTimer) clearTimeout(job.pregenTimer)
      this.invalidateDelivery(name)
      this.jobs.delete(name)
      this.pregenCache.delete(name)
      this.persistPregen()
      if (!keepIntel) this.intel.drop(name)
      this.persist()
      this.deps.audit.record("cron.removed", { name, keepIntel: keepIntel || undefined })
      return keepIntel ? `已卸下定时任务 **${name}**（档案保留）` : `已删除定时任务 **${name}**`
    }
    if (this.pausedJobs.delete(name)) {
      if (!keepIntel) this.intel.drop(name)
      this.persist()
      this.deps.audit.record("cron.removed", { name, paused: true, keepIntel: keepIntel || undefined })
      return keepIntel ? `已卸下定时任务 **${name}**（档案保留）` : `已删除定时任务 **${name}**`
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

function formatNext(date: Date | null | undefined): string {
  if (!date) return "按原计划"
  const zone = "Asia/Shanghai"
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone })
  const day = date.toLocaleDateString("zh-CN", { timeZone: zone })
  const today = new Date().toLocaleDateString("zh-CN", { timeZone: zone })
  if (day === today) return time
  const md = date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", timeZone: zone })
  return `${md} ${time}`
}
