import type { CardActionEvent } from "@larksuiteoapi/node-sdk"
import type { OpencodeClient } from "../opencode/client.js"
import type { FormField, FormInfo, FormValue, PermissionRequest } from "../opencode/types.js"
import type { AuditLog, Logger } from "../util/logger.js"
import type { FeishuBot } from "../feishu/bot.js"
import type { ChatIdentity, ConversationService, SessionContext } from "./conversations.js"
import { buildMailDigestPrompt, type CronController } from "./commands.js"
import { cronDeleteConfirmCard, cronFormCancelCard, cronManageCard, formCard, isMailJob, mailSubscribeCard, makeFormCard, makeSubmittedCard, permissionCard, statusCard, subscribeCard, type CardValue } from "../feishu/cards.js"
import { KeyedSerial } from "../util/async.js"

/** 订阅表单的频率 option value 映射到 cron 的日/周字段 */
const FREQ_TABLE: Record<string, { dom: string; dow: string }> = {
  daily: { dom: "*", dow: "*" },
  workday: { dom: "*", dow: "mon-fri" },
  mon: { dom: "*", dow: "mon" },
  tue: { dom: "*", dow: "tue" },
  wed: { dom: "*", dow: "wed" },
  thu: { dom: "*", dow: "thu" },
  fri: { dom: "*", dow: "fri" },
  sat: { dom: "*", dow: "sat" },
  sun: { dom: "*", dow: "sun" },
  dom1: { dom: "1", dow: "*" },
  dom15: { dom: "15", dow: "*" },
}

/** 邮件日报的总结范围（天）随频率：每天/每工作日看前一天，每周看前一周，半月看 15 天，每月看 30 天。 */
const FREQ_DAYS: Record<string, number> = {
  daily: 1,
  workday: 1,
  mon: 7,
  tue: 7,
  wed: 7,
  thu: 7,
  fri: 7,
  sat: 7,
  sun: 7,
  dom1: 30,
  dom15: 15,
}

interface PendingForm {
  form: FormInfo
  answers: Record<string, FormValue>
  messageId?: string
  context: SessionContext
}

export interface InteractionDeps {
  logger: Logger
  audit: AuditLog
  conversations: ConversationService
  getClient: () => Promise<OpencodeClient>
  getBot: (name: string) => FeishuBot | undefined
  getContext: (sessionID: string) => SessionContext | undefined
  activeSessions: () => string[]
  pollIntervalMs?: number
  completeGapFill?: (
    bot: FeishuBot,
    token: string,
    answers: Record<string, string>,
    messageId: string,
  ) => Promise<void>
  /** Lazily resolve the cron controller (it is constructed after this service). */
  getCron?: () => CronController | undefined
}

/**
 * Bridges OpenCode permissions and forms (the AI asking a question) to Feishu
 * interactive cards, and routes card callbacks back to OpenCode.
 *
 * Detection combines the live event stream with polling of the pending lists,
 * so it works regardless of the exact event names a given OpenCode build uses.
 */
export class InteractionService {
  private readonly handledPermissions = new Set<string>()
  private readonly pendingForms = new Map<string, PendingForm>()
  private readonly sessionsWithPermission = new Set<string>()
  private readonly actionSerial = new KeyedSerial()
  private timer?: NodeJS.Timeout
  private polling = false

  constructor(private readonly deps: InteractionDeps) {}

  /** True while a session is blocked on a permission prompt or a question form. */
  hasPending(sessionID: string): boolean {
    if (this.sessionsWithPermission.has(sessionID)) return true
    for (const pending of this.pendingForms.values()) {
      if (pending.form.sessionID === sessionID) return true
    }
    return false
  }

  start(): void {
    if (this.timer) return
    const interval = this.deps.pollIntervalMs ?? 2_000
    this.timer = setInterval(() => void this.poll(), interval)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Watch a session for pending interactions (called when a turn starts). */
  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const client = await this.deps.getClient()
      for (const sessionID of this.deps.activeSessions()) {
        await this.pollSession(client, sessionID)
      }
    } catch {
      // transient; retry next tick
    } finally {
      this.polling = false
    }
  }

  private async pollSession(client: OpencodeClient, sessionID: string): Promise<void> {
    const context = this.deps.getContext(sessionID)
    if (!context) return
    const bot = this.deps.getBot(context.botName)
    if (!bot) return

    try {
      const permissions = await client.pendingPermissions(sessionID)
      if (permissions.length > 0) this.sessionsWithPermission.add(sessionID)
      else this.sessionsWithPermission.delete(sessionID)
      const currentIds = new Set(permissions.map((p) => p.id))
      for (const id of [...this.handledPermissions]) {
        if (!currentIds.has(id)) this.handledPermissions.delete(id)
      }
      for (const request of permissions) {
        if (this.handledPermissions.has(request.id)) continue
        this.handledPermissions.add(request.id)
        await this.presentPermission(bot, context, request)
      }
    } catch (error) {
      this.deps.logger.debug("Permission poll failed", { sessionID, error: message(error) })
    }

    try {
      const forms = await client.pendingForms(sessionID)
      const currentIds = new Set(forms.map((f) => f.id))
      for (const [id, pending] of [...this.pendingForms]) {
        if (pending.form.sessionID === sessionID && !currentIds.has(id)) this.pendingForms.delete(id)
      }
      for (const form of forms) {
        if (this.pendingForms.has(form.id)) continue
        await this.presentForm(bot, context, form)
      }
    } catch (error) {
      this.deps.logger.debug("Form poll failed", { sessionID, error: message(error) })
    }
  }

  private async presentPermission(bot: FeishuBot, context: SessionContext, request: PermissionRequest): Promise<void> {
    this.deps.audit.record("permission.requested", {
      sessionID: request.sessionID,
      requestID: request.id,
      action: request.action,
      resources: request.resources,
    })
    try {
      await bot.sendCard(context.chatId, permissionCard(request), { replyTo: context.replyTo })
    } catch (error) {
      this.deps.logger.warn("Failed to send permission card", { error: message(error) })
    }
  }

  private async presentForm(bot: FeishuBot, context: SessionContext, form: FormInfo): Promise<void> {
    const pending: PendingForm = { form, answers: {}, context }
    this.pendingForms.set(form.id, pending)
    this.deps.audit.record("form.requested", { sessionID: form.sessionID, formID: form.id, title: form.title })
    const card = formCard(form, {})
    try {
      const result = await bot.sendCardResilient(context.chatId, card, { replyTo: context.replyTo })
      pending.messageId = result.messageId
    } catch (error) {
      this.deps.logger.warn("Failed to send form card", { error: message(error) })
      // Fall back to a text prompt so the question is still answerable.
      try {
        await bot.sendMarkdownResilient(context.chatId, renderFormAsText(form), { replyTo: context.replyTo })
      } catch (fallbackError) {
        this.deps.logger.warn("Failed to send form text fallback", { error: message(fallbackError) })
      }
    }
  }

  // ---- card callbacks -----------------------------------------------------

  async handleCardAction(bot: FeishuBot, event: CardActionEvent): Promise<void> {
    const value = event.action.value as CardValue | undefined
    if (!value || typeof value !== "object" || !("k" in value)) return
    // Acknowledge Feishu immediately. The SDK only sends the card-callback
    // response after this method resolves, and Feishu times out at ~3s ??    // replying to OpenCode and patching the card can exceed that. Do the work
    // off the critical path, serialized per card so rapid clicks don't race.
    const key = `${event.messageId}:${value.k}:${value.f ?? value.r ?? value.d ?? ""}`
    void this.actionSerial
      .run(key, () => this.processCardAction(bot, event, value))
      .catch((error) => this.deps.logger.warn("Card action failed", { error: message(error) }))
  }

  private async processCardAction(bot: FeishuBot, event: CardActionEvent, value: CardValue): Promise<void> {
    this.deps.audit.record("card.action", {
      bot: bot.name,
      chatId: event.chatId,
      operator: event.operator.openId,
      kind: value.k,
    })
    if (value.k === "perm" && value.s && value.r && value.d) {
      await this.resolvePermission(bot, event, value.s, value.r, value.d as "once" | "always" | "reject")
    } else if (value.k === "form" && value.s && value.f) {
      await this.resolveFormAction(bot, event, value)
    } else if (value.k === "gap" && value.f) {
      await this.resolveGapFill(bot, event, value.f)
    } else if (value.k === "cron-sub") {
      await this.resolveCronSubscribe(bot, event, value)
    } else if (value.k === "cron-mail-sub") {
      await this.resolveMailSubscribe(bot, event, value)
    } else if (value.k === "cron-cancel") {
      // 表单「取消」：忽略已填内容，原卡换成取消提示（编辑态带上原任务名）。
      await bot.updateCard(event.messageId, cronFormCancelCard(value.f, value.d))
    } else if (value.k === "cron-pause" && value.d) {
      await this.resolveCronToggle(bot, event, value.d)
    } else if (value.k === "cron-urgent" && value.d) {
      await this.resolveCronUrgent(bot, event, value.d)
    } else if (value.k === "cron-del" && value.d) {
      await bot.updateCard(event.messageId, cronDeleteConfirmCard(value.d))
    } else if (value.k === "cron-del-yes" && value.d) {
      await this.resolveCronRemove(bot, event, value.d)
    } else if (value.k === "cron-edit" && value.d) {
      await this.resolveCronEdit(bot, event, value.d)
    } else if (value.k === "cron-mgr") {
      await this.refreshCronManage(bot, event)
    } else if (value.k === "make-form" && value.f) {
      await this.resolveMakeForm(bot, event, value.f)
    } else if (value.k === "make-sub" && value.f) {
      await this.resolveMakeSubmit(bot, event, value.f, value.n)
    } else if (value.k === "make-refresh" && value.f) {
      await this.resolveMakeRefresh(bot, event, value.f, value.n)
    } else if (value.k === "make-addfile" && value.f) {
      await this.resolveMakeAddFile(bot, event, value.f, value.n)
    } else if (value.k === "make-cancel") {
      await this.resolveMakeCancel(bot, event, value.n)
    }
  }

  /** 「取消」:主动作废这张表单卡——编号消费,此后卡上所有按钮都不再可用。 */
  private async resolveMakeCancel(bot: FeishuBot, event: CardActionEvent, nonce?: number): Promise<void> {
    if (!this.deps.conversations.makeFormActive(event.chatId, event.operator.openId, nonce)) {
      await this.rejectStaleMakeForm(bot, event)
      return
    }
    this.deps.conversations.revokeMakeForm(event.chatId, event.operator.openId)
    await bot.updateCard(
      event.messageId,
      statusCard("已取消", "本次生成任务已取消,这张卡片已作废。需要制作时从菜单重新打开。", "grey"),
    )
  }

  /** A make-form is single-use: any action on a superseded card gets this notice. */
  private async rejectStaleMakeForm(bot: FeishuBot, event: CardActionEvent): Promise<void> {
    await bot.updateCard(
      event.messageId,
      statusCard(
        "⏳ 表单已失效",
        "这张表单已被取代:你之后发起了其他任务,或打开了新的制作表单。\n如需制作,请从菜单「制作 > 文档制作」重新打开。",
        "grey",
      ),
    )
  }

  /**
   * 「添加本地文件」:记下当前表单输入,请用户用原生「+ → 本机文件」发文件;
   * 文件到达后表单卡自动重渲染(已填内容回填、新文件自动勾选),无需手动刷新。 */
  private async resolveMakeAddFile(bot: FeishuBot, event: CardActionEvent, format: string, nonce?: number): Promise<void> {
    const f = format === "pptx" || format === "docx" || format === "pdf" || format === "xlsx" || format === "copy" ? format : undefined
    if (!f) return
    if (!this.deps.conversations.makeFormActive(event.chatId, event.operator.openId, nonce)) {
      await this.rejectStaleMakeForm(bot, event)
      return
    }
    const values = extractFormValues(event)
    this.deps.conversations.beginMakeUpload(event.chatId, event.operator.openId, event.messageId, f, {
      instruction: String(values.instruction ?? "").trim() || undefined,
      template: String(values.template ?? "").trim() || undefined,
      cloud: String(values.cloud ?? "").trim() || undefined,
      files: Array.isArray(values.files) ? values.files.map(String) : undefined,
    })
    await bot
      .sendMarkdown(
        event.chatId,
        "请点输入框左侧 **+ → 本机文件**,选好文件发送(可多选)。收到后表单会自动更新并勾选,已填写的指令不会丢。",
        { replyTo: event.messageId },
      )
      .catch(() => {})
  }

  /**
   * 「刷新文件列表」:带着当前表单输入重渲染——已填内容回填,刚拖进聊天的
   * 新文件(近 2 分钟入缓存)自动勾选,免去找回的麻烦。 */
  private async resolveMakeRefresh(bot: FeishuBot, event: CardActionEvent, format: string, nonce?: number): Promise<void> {
    const f = format === "pptx" || format === "docx" || format === "pdf" || format === "xlsx" || format === "copy" ? format : undefined
    if (!f) return
    if (!this.deps.conversations.makeFormActive(event.chatId, event.operator.openId, nonce)) {
      await this.rejectStaleMakeForm(bot, event)
      return
    }
    const values = extractFormValues(event)
    const data = this.deps.conversations.makeFormData(event.chatId, event.operator.openId, f)
    const checked = new Set(Array.isArray(values.files) ? values.files.map(String) : [])
    const now = Date.now()
    for (const file of data.files) {
      const savedAt = Number(/^(\d+)_/.exec(file.value)?.[1] ?? 0)
      if (savedAt > 0 && now - savedAt < 2 * 60_000) checked.add(file.value)
    }
    await bot.updateCard(
      event.messageId,
      makeFormCard(
        data,
        {
          instruction: String(values.instruction ?? "").trim() || undefined,
          template: String(values.template ?? "").trim() || undefined,
          cloud: String(values.cloud ?? "").trim() || undefined,
          files: [...checked].filter((key) => data.files.some((file) => file.value === key)),
        },
        this.deps.conversations.rollMakeFormNonce(event.chatId, event.operator.openId),
      ),
    )
  }

  /** 品类按钮 → 原卡原地换成对应制作表单。 */
  private async resolveMakeForm(bot: FeishuBot, event: CardActionEvent, format: string): Promise<void> {
    const f = format === "pptx" || format === "docx" || format === "pdf" ? format : undefined
    if (!f) return
    const data = this.deps.conversations.makeFormData(event.chatId, event.operator.openId, f)
    const nonce = this.deps.conversations.issueMakeForm(event.chatId, event.operator.openId)
    await bot.updateCard(event.messageId, makeFormCard(data, undefined, nonce))
  }

  /** 制作表单提交:校验 → 组装任务 → 原卡换成确认卡,生成走正常流式流程。 */
  private async resolveMakeSubmit(bot: FeishuBot, event: CardActionEvent, format: string, nonce?: number): Promise<void> {
    const f = format === "pptx" || format === "docx" || format === "pdf" || format === "xlsx" || format === "copy" ? format : undefined
    if (!f) return
    if (!this.deps.conversations.makeFormActive(event.chatId, event.operator.openId, nonce)) {
      await this.rejectStaleMakeForm(bot, event)
      return
    }
    const values = extractFormValues(event)
    const instruction = String(values.instruction ?? "").trim()
    if (instruction.length < 4) {
      await bot.updateCard(
        event.messageId,
        statusCard("⚠️ 任务未提交", "请填写具体指令(至少 4 个字),再点「开始生成」。", "orange"),
      )
      return
    }
    const fileKeys = Array.isArray(values.files) ? values.files.map(String).filter((key) => key.length > 0) : []
    const template = String(values.template ?? "").trim()
    const cloud = String(values.cloud ?? "").trim()
    const chat = await bot.getChatInfo(event.chatId).catch(() => undefined)
    const chatType = String((chat as { chatType?: string } | undefined)?.chatType ?? "p2p")
    const result = await this.deps.conversations.submitMake(bot, {
      chatId: event.chatId,
      chatType: chatType === "group" ? "group" : "p2p",
      senderId: event.operator.openId,
      format: f,
      instruction,
      fileKeys,
      template,
      cloud,
    })
    if (!result.ok) {
      await bot.updateCard(event.messageId, statusCard("⚠️ 任务未提交", result.error, "orange"))
      return
    }
    this.deps.conversations.revokeMakeForm(event.chatId, event.operator.openId)
    await bot.updateCard(event.messageId, makeSubmittedCard(f, instruction, fileKeys.length, template))
  }

  private async refreshCronManage(bot: FeishuBot, event: CardActionEvent): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron) {
      await bot.sendText(event.chatId, "定时任务未启用。")
      return
    }
    await bot.updateCard(event.messageId, cronManageCard(cron.list()))
  }

  private async resolveCronToggle(bot: FeishuBot, event: CardActionEvent, name: string): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron) return
    const enabled = cron.togglePause(name)
    if (enabled === undefined) {
      await bot.sendText(event.chatId, `未找到订阅「${name}」`)
      return
    }
    this.deps.audit.record(enabled ? "cron.resumed" : "cron.paused", { name, operator: event.operator.openId })
    await this.refreshCronManage(bot, event)
  }

  private async resolveCronUrgent(bot: FeishuBot, event: CardActionEvent, name: string): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron) return
    const urgent = cron.toggleUrgent(name)
    if (urgent === undefined) {
      await bot.sendText(event.chatId, `未找到订阅「${name}」`)
      return
    }
    await this.refreshCronManage(bot, event)
  }

  private async resolveCronRemove(bot: FeishuBot, event: CardActionEvent, name: string): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron) return
    await cron.remove(name)
    await this.refreshCronManage(bot, event)
  }

  /** 编辑 = 原卡换成预填的订阅表单;提交走 cron-sub/cron-mail-sub,value.f 带旧名用于替换。 */
  private async resolveCronEdit(bot: FeishuBot, event: CardActionEvent, name: string): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron) return
    const job = cron.list().find((j) => j.name === name)
    if (!job) {
      await bot.sendText(event.chatId, `未找到订阅「${name}」`)
      return
    }
    // 邮件类订阅用邮件管理表单（管理要求从组装 prompt 里反解）；资讯订阅用原表单。
    if (isMailJob(job)) {
      await bot.updateCard(event.messageId, mailSubscribeCard({ name: job.name, schedule: job.schedule }))
      return
    }
    await bot.updateCard(event.messageId, subscribeCard(job))
  }

  /**
   * 邮件订阅表单提交：表单只有频率和时间，日报逻辑固定（buildMailDigestPrompt），
   * 总结范围随频率（FREQ_DAYS）。名称固定「邮件管理」——一个邮箱一份管理订阅，
   * 重复创建同名即覆盖。value.f 带旧名时为编辑（同名替换）。
   */
  private async resolveMailSubscribe(bot: FeishuBot, event: CardActionEvent, value: CardValue): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron) {
      await bot.sendText(event.chatId, "定时任务未启用。")
      return
    }
    const values = extractFormValues(event)
    const freqKey = String(values.freq ?? "")
    const freq = FREQ_TABLE[freqKey]
    const hour = Number(values.hour)
    const minute = Number(values.minute)
    if (!freq || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      await bot.updateCard(
        event.messageId,
        statusCard(
          "⚠️ 邮件订阅未提交",
          "表单信息不完整：请选择总结频率、小时和分钟。\n从菜单「订阅 > 邮件订阅」可重新打开表单。",
          "orange",
        ),
      )
      return
    }
    const name = value.f ?? "邮件管理"
    const days = FREQ_DAYS[freqKey] ?? 1
    const chat = await bot.getChatInfo(event.chatId).catch(() => undefined)
    const chatType = String((chat as { chatType?: string } | undefined)?.chatType ?? "p2p")
    const identity: ChatIdentity = {
      chatId: event.chatId,
      chatType: chatType === "group" ? "group" : "p2p",
      senderId: event.operator.openId,
      senderName: event.operator.name ?? "user",
    }
    const result = await cron.add(
      [name, String(minute), String(hour), freq.dom, "*", freq.dow, buildMailDigestPrompt(days)],
      identity,
      bot.name,
    )
    this.deps.audit.record("cron.subscribe_card", { bot: bot.name, chatId: event.chatId, name, operator: event.operator.openId, edit: value.f, kind: "mail" })
    await bot.updateCard(
      event.messageId,
      statusCard(
        "📮 邮件管理已开启",
        `${result}\n每次总结过去 **${days} 天**的收件箱，着重列出需要尽快回复的邮件、未来两周内有截止日期的事项（提前 15 分钟静默预生成，响铃加急）；重要性「高」的新邮件实时单独推送。`,
        "green",
      ),
    )
  }

  /** 订阅表单卡提交:option value 已带频率等字段,在这里校验与组装。value.f 带旧订阅名时为编辑替换。 */
  private async resolveCronSubscribe(bot: FeishuBot, event: CardActionEvent, value: CardValue): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron) {
      await bot.sendText(event.chatId, "定时任务未启用。")
      return
    }
    const values = extractFormValues(event)
    const prompt = String(values.prompt ?? "").trim()
    const freq = FREQ_TABLE[String(values.freq ?? "")]
    const hour = Number(values.hour)
    const minute = Number(values.minute)
    if (!freq || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || prompt.length < 4) {
      await bot.updateCard(
        event.messageId,
        statusCard(
          "⚠️ 订阅未提交",
          "表单信息不完整:请填写订阅内容(至少 4 个字),并选择频率和时间。\n从菜单「订阅 > 资讯订阅」可重新打开订阅表单。",
          "orange",
        ),
      )
      return
    }
    const name = `订阅-${prompt.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "").slice(0, 8) || "资讯"}`
    const chat = await bot.getChatInfo(event.chatId).catch(() => undefined)
    const chatType = String((chat as { chatType?: string } | undefined)?.chatType ?? "p2p")
    const identity: ChatIdentity = {
      chatId: event.chatId,
      chatType: chatType === "group" ? "group" : "p2p",
      senderId: event.operator.openId,
      senderName: event.operator.name ?? "user",
    }
    const result = await cron.add(
      [name, String(minute), String(hour), freq.dom, "*", freq.dow, prompt],
      identity,
      bot.name,
    )
    let suffix = ""
    if (value.f && value.f !== name) {
      // Edit mode with a renamed subscription: drop the old entry after the new one lands.
      await cron.remove(value.f)
      suffix = `\n已替换旧订阅 **${value.f}**。`
    }
    this.deps.audit.record("cron.subscribe_card", { bot: bot.name, chatId: event.chatId, name, operator: event.operator.openId, edit: value.f })
    await bot.updateCard(event.messageId, statusCard("⏰ 订阅结果", result + suffix, "green"))
  }

  /** Text the user typed into a system gap-fill card. This is not an agent question. */
  private async resolveGapFill(bot: FeishuBot, event: CardActionEvent, token: string): Promise<void> {
    const answers: Record<string, string> = {}
    for (const [key, raw] of Object.entries(extractFormValues(event))) {
      if (!/^g\d+$/.test(key)) continue
      answers[key] = raw == null ? "" : String(raw)
    }
    await this.deps.completeGapFill?.(bot, token, answers, event.messageId)
  }

  private async resolvePermission(
    bot: FeishuBot,
    event: CardActionEvent,
    sessionID: string,
    requestID: string,
    decision: "once" | "always" | "reject",
  ): Promise<void> {
    const client = await this.deps.getClient()
    await client.replyPermission(sessionID, requestID, decision)
    this.handledPermissions.add(requestID)
    const label = decision === "once" ? "仅本次允许" : decision === "always" ? "始终允许" : "已拒绝"
    this.deps.audit.record("permission.replied", { sessionID, requestID, decision })
    try {
      await bot.updateCard(event.messageId, statusCard("🔐 授权已处理", `决定:**${label}**`, decision === "reject" ? "red" : "green"))
    } catch {
      // card may be gone
    }
  }

  private async resolveFormAction(bot: FeishuBot, event: CardActionEvent, value: CardValue): Promise<void> {
    const pending = value.f ? this.pendingForms.get(value.f) : undefined
    if (!pending) {
      await bot.sendText(event.chatId, "该问题已结束或不存在。")
      return
    }
    // Values the user typed into the card's input fields. The card wraps every
    // field in a `form` container, so option clicks and the submit button both
    // deliver the full set of typed answers in `action.form_value`.
    for (const [key, raw] of Object.entries(extractFormValues(event))) {
      const field = pending.form.fields.find((f) => f.key === key)
      if (!field) continue
      const text = raw == null ? "" : String(raw)
      if (text.trim() === "") continue
      pending.answers[key] = field.type === "multiselect" ? splitList(text) : coerce(field, text)
    }
    // An option click (or boolean toggle) wins for that one field, applied last
    // so it is not overwritten by the field's own input default value.
    let multiselectToggle = false
    if (value.key !== undefined) {
      const field = pending.form.fields.find((f) => f.key === value.key)
      if (field?.type === "multiselect") {
        // Toggle selection; submission happens via the explicit submit button.
        multiselectToggle = true
        const current = Array.isArray(pending.answers[value.key]) ? (pending.answers[value.key] as string[]) : []
        const next = String(value.v)
        const index = current.indexOf(next)
        if (index >= 0) current.splice(index, 1)
        else current.push(next)
        pending.answers[value.key] = current
      } else {
        pending.answers[value.key] = normaliseAnswer(value.v)
      }
    }
    const explicitSubmit = value.key === undefined
    const submitted = await this.maybeSubmit(bot, event.chatId, pending, explicitSubmit, !multiselectToggle)
    if (!submitted) await this.refreshFormCard(bot, pending)
  }

  /** Handle `/answer <formId?> key=value ...` from a chat. */
  async answer(sessionID: string, args: string): Promise<string> {
    const pending = [...this.pendingForms.values()].find((p) => p.form.sessionID === sessionID)
    if (!pending) return "当前没有待回答的问题。"
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    let target = pending
    const first = tokens[0]
    if (first && this.pendingForms.has(first)) {
      target = this.pendingForms.get(first) as PendingForm
      tokens.shift()
    }
    return this.applyAnswers(target, tokens)
  }

  private async applyAnswers(pending: PendingForm, tokens: string[]): Promise<string> {
    const applied: string[] = []
    for (const token of tokens) {
      const eq = token.indexOf("=")
      if (eq === -1) continue
      const key = token.slice(0, eq)
      const raw = token.slice(eq + 1)
      const field = pending.form.fields.find((f) => f.key === key)
      if (!field) continue
      pending.answers[key] = coerce(field, raw)
      applied.push(`${key}=${raw}`)
    }
    if (applied.length === 0) return "用法应为:/answer key=value(可多个,用空格分隔)"
    const bot = this.deps.getBot(pending.context.botName)
    if (!bot) return "找不到对应的机器人。"
    const submitted = await this.maybeSubmit(bot, pending.context.chatId, pending, true)
    if (!submitted) await this.refreshFormCard(bot, pending)
    return submitted ? `已提交,答案:${applied.join(", ")}` : `已记录:${applied.join(", ")}`
  }

  /**
   * Attempt to submit. When `force` is false the form auto-submits only once
   * every visible field has an answer; when true (an explicit submit) it
   * requires the same, warning about anything still blank rather than sending a
   * partial answer (which OpenCode treats as the user abandoning the question).
   *
   * `allowAuto` disables the implicit submit a click otherwise triggers ??used
   * for multiselect toggles so the user can pick several options before
   * pressing submit.
   */
  private async maybeSubmit(
    bot: FeishuBot,
    chatId: string,
    pending: PendingForm,
    force: boolean,
    allowAuto = true,
  ): Promise<boolean> {
    const visible = pending.form.fields.filter((f) => !f.hidden && f.type !== "external")
    const answered = (f: FormField) => isAnswered(pending.answers[f.key])
    const missing = visible.filter((f) => !answered(f))
    if (!force && (missing.length > 0 || !allowAuto)) return false
    if (force && missing.length > 0) {
      const labels = missing.map((f) => f.title ?? f.key)
      await bot
        .sendText(chatId, `还有问题没有回答:${labels.join("、")}\n请选择选项,或在聊天中直接填写并提交。`)
        .catch(() => {})
      return false
    }
    const client = await this.deps.getClient()
    try {
      await client.replyForm(pending.form.sessionID, pending.form.id, pending.answers)
    } catch (error) {
      // The question was cancelled/finished on the OpenCode side, or the answer
      // was rejected. Surface it instead of silently leaving the card stuck.
      this.pendingForms.delete(pending.form.id)
      this.deps.logger.warn("Failed to submit form answer", {
        formID: pending.form.id,
        error: message(error),
      })
      this.deps.audit.record("form.failed", { formID: pending.form.id, error: message(error) })
      await this.updateFormCard(pending, statusCard("⚠️ 问题已失效", "该问题已失效或超时,请重新发起。", "orange"))
      return true
    }
    this.pendingForms.delete(pending.form.id)
    this.deps.audit.record("form.replied", { formID: pending.form.id, answers: pending.answers })
    if (pending.messageId) {
      const summary = Object.entries(pending.answers)
        .map(([k, v]) => `- **${k}**:${Array.isArray(v) ? v.join(", ") : v}`)
        .join("\n")
      await this.updateFormCard(pending, statusCard("✅ 已提交答案", summary, "green"))
    }
    return true
  }

  private async updateFormCard(pending: PendingForm, card: object): Promise<void> {
    if (!pending.messageId) return
    try {
      await this.deps.getBot(pending.context.botName)?.updateCard(pending.messageId, card)
    } catch {
      // card may be gone
    }
  }

  private async refreshFormCard(bot: FeishuBot, pending: PendingForm): Promise<void> {
    if (!pending.messageId) return
    try {
      await bot.updateCard(pending.messageId, formCard(pending.form, pending.answers))
    } catch (error) {
      this.deps.logger.debug("Failed to refresh form card", { error: message(error) })
    }
  }
}

function normaliseAnswer(value: unknown): FormValue {
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value
  return String(value)
}

function coerce(field: FormField, raw: string): FormValue {
  if (field.type === "number" || field.type === "integer") {
    const n = Number(raw)
    return Number.isNaN(n) ? raw : field.type === "integer" ? Math.trunc(n) : n
  }
  if (field.type === "boolean") return raw === "true" || raw === "是" || raw === "1"
  if (field.type === "multiselect") return raw.split(",").map((v) => v.trim()).filter(Boolean)
  return raw
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Plain-markdown rendering of a form so it stays answerable when the card fails. */
function renderFormAsText(form: FormInfo): string {
  const lines = [`🤖 **AI 提问:${form.title}**`]
  if (form.metadata && typeof form.metadata === "object" && "description" in form.metadata) {
    lines.push(String((form.metadata as { description: unknown }).description))
  }
  const fields = form.fields.filter((field) => !field.hidden)
  fields.forEach((field, index) => {
    const title = field.title ?? field.key
    const required = field.required ? "(必填)" : ""
    lines.push(`${index + 1}. **${title}**${required}${field.description ? `:${field.description}` : ""}`)
    if (field.options?.length) {
      lines.push(`   选项:${field.options.map((option) => option.value).join(" / ")}`)
    }
  })
  const sample = fields[0]
  const hint = !sample
    ? "key=value"
    : sample.type === "multiselect"
      ? `${sample.key}=选项1,选项2`
      : sample.type === "boolean"
        ? `${sample.key}=true`
        : `${sample.key}=你的答案`
  lines.push(`\n请回复:\`/answer ${hint}\`(多个字段用空格分隔)`)
  return lines.join("\n")
}

/**
 * Read the typed input values a card `form` submits. Feishu delivers them as
 * `action.form_value` (a name→value map). The SDK's normalized event does not
 * surface the field, so we probe the raw payload at the shapes seen across
 * surfaces, and fall back to the (runtime-only) `action` property.
 */
function extractFormValues(event: CardActionEvent): Record<string, unknown> {
  const candidates: unknown[] = [
    (event.action as { form_value?: unknown } | undefined)?.form_value,
    (event.raw as { action?: { form_value?: unknown } } | undefined)?.action?.form_value,
    (event.raw as { event?: { action?: { form_value?: unknown } } } | undefined)?.event?.action?.form_value,
  ]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>
    }
  }
  return {}
}

/** Whether a field has a usable answer (the AI treats a blank field as unanswered). */
function isAnswered(value: FormValue | undefined): boolean {
  // Note: `false` and `0` are valid answers, so only absent/blank values count
  // as unanswered.
  if (value === undefined || value === null) return false
  if (typeof value === "string") return value.trim() !== ""
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** Split a free-text list answer into individual values (multiselect fields). */
function splitList(text: string): string[] {
  return text
    .split(/[,，、\n]/)
    .map((value) => value.trim())
    .filter(Boolean)
}
