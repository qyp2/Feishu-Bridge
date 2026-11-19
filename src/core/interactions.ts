import type { CardActionEvent } from "@larksuiteoapi/node-sdk"
import type { OpencodeClient } from "../opencode/client.js"
import type { FormField, FormInfo, FormValue, PermissionRequest } from "../opencode/types.js"
import type { AuditLog, Logger } from "../util/logger.js"
import { bindCardOwner, mentionsFor, stageCardToast, type FeishuBot } from "../feishu/bot.js"
import { extractFormValues, formFieldString, formStringList, formValueKeySummary } from "../feishu/formValues.js"
import type { ChatIdentity, ConversationService, SessionContext } from "./conversations.js"
import { buildMailDigestPrompt, lookupUserEmail, type CronController, type CronJobInfo } from "./commands.js"
import { buildProductContextPrompt, detectProductContext } from "./product-context.js"
import { cronDeleteConfirmCard, cronFormCancelCard, cronManageCard, formCard, isMailJob, loginCard, loginDoneCard, mailJobName, mailSubscribeCard, MAKE_FORM_FILE_PLACEHOLDER, makeFormCard, makeSubmittedCard, parseDeckTask, permissionCard, skillDeleteConfirmCard, skillFormCard, skillManageCard, skillSavedCard, statusCard, studioCard, studioPendingCard, studioResultCard, subscribeCard, type CardValue, type DeckTask, type MakeFormat, type MakeFormData, type MakeFormPreset, type SkillFormDraft, type StudioDraft, type StudioKind } from "../feishu/cards.js"
import { CONFIG_CHANGE_DENIED, isProtectedConfigTarget } from "./configGuard.js"
import type { IntelArchiveStore } from "../intel/archive.js"
import { intelDigestCard, intelToast } from "../intel/cards.js"
import { intelActionPrompt, type IntelScene } from "../intel/prompts.js"
import { parseTriggers, type SkillDraft } from "../skills/store.js"
import { KeyedSerial } from "../util/async.js"
import type { MailBindingStore } from "../mail/binding.js"
import { StudioApiError } from "../studio/client.js"
import type { StudioService } from "../studio/service.js"

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
  getIntel?: () => IntelArchiveStore | undefined
  getMailBinding?: () => MailBindingStore | undefined
  /** 创作工作台 / 验证码登录（玉树 OpenAPI）；未注入时保持预览行为。 */
  studio?: StudioService
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
  private readonly smsSentAt = new Map<string, number>()
  /** 校验失败后卡片回填与服务端合并，避免飞书只回传部分 form_value。 */
  private readonly pendingSkillForms = new Map<string, SkillFormDraft>()
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
      let permissions = await client.pendingPermissions(sessionID)
      if (context.turnSource === "cron" && permissions.length > 0) {
        await this.autoGrantCronPermissions(client, context, permissions)
        permissions = await client.pendingPermissions(sessionID).catch(() => [])
      }
      if (permissions.length > 0) this.sessionsWithPermission.add(sessionID)
      else this.sessionsWithPermission.delete(sessionID)
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

  /** Cron / mail pregen runs unattended: approve all tool paths except protected bridge config. */
  private async autoGrantCronPermissions(
    client: OpencodeClient,
    context: SessionContext,
    permissions: PermissionRequest[],
  ): Promise<void> {
    for (const request of permissions) {
      if (this.handledPermissions.has(request.id)) continue
      this.handledPermissions.add(request.id)
      const reject = request.resources.some((resource) => isProtectedConfigTarget(resource))
      const decision = reject ? "reject" : "always"
      await client.replyPermission(request.sessionID, request.id, decision).catch(() => {})
      this.deps.audit.record("permission.auto", {
        sessionID: request.sessionID,
        requestID: request.id,
        action: request.action,
        decision,
        chatId: context.chatId,
      })
    }
  }

  private async presentPermission(bot: FeishuBot, context: SessionContext, request: PermissionRequest): Promise<void> {
    this.deps.audit.record("permission.requested", {
      sessionID: request.sessionID,
      requestID: request.id,
      action: request.action,
      resources: request.resources,
    })
    if (request.resources.some((resource) => isProtectedConfigTarget(resource))) {
      const client = await this.deps.getClient()
      await client.replyPermission(request.sessionID, request.id, "reject").catch(() => {})
      this.deps.audit.record("config.change.denied", {
        sessionID: request.sessionID,
        action: request.action,
        resources: request.resources,
      })
      if (context.chatType === "group") {
        await bot
          .sendText(context.chatId, CONFIG_CHANGE_DENIED, {
            replyTo: context.replyTo,
            mentions: mentionsFor("group", context.userOpenId),
          })
          .catch(() => {})
      }
      return
    }
    try {
      await bot.sendCard(context.chatId, permissionCard(request), {
        replyTo: context.replyTo,
        mentions: mentionsFor(context.chatType ?? "p2p", context.userOpenId),
      })
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
      const result = await bot.sendCardResilient(context.chatId, card, {
        replyTo: context.replyTo,
        mentions: mentionsFor(context.chatType ?? "p2p", context.userOpenId),
      })
      pending.messageId = result.messageId
    } catch (error) {
      this.deps.logger.warn("Failed to send form card", { error: message(error) })
      // Fall back to a text prompt so the question is still answerable.
      try {
        await bot.sendMarkdownResilient(context.chatId, renderFormAsText(form), {
          replyTo: context.replyTo,
          mentions: mentionsFor(context.chatType ?? "p2p", context.userOpenId),
        })
      } catch (fallbackError) {
        this.deps.logger.warn("Failed to send form text fallback", { error: message(fallbackError) })
      }
    }
  }

  // ---- card callbacks -----------------------------------------------------

  async handleCardAction(bot: FeishuBot, event: CardActionEvent): Promise<void> {
    const value = parseCardCallbackValue(event.action.value)
    if (!value) return
    if (value.k === "intel") {
      if (value.o && event.operator.openId !== value.o) {
        stageCardToast("这张卡片只有发起人可以操作。", "warning")
        return
      }
      const toast = intelToast(value.d)
      stageCardToast(toast.content, toast.type)
    }
    // Acknowledge Feishu immediately. The SDK only sends the card-callback
    // response after this method resolves, and Feishu times out at about 3s.
    // Replying to OpenCode and patching the card can exceed that, so the work
    // runs off the critical path, serialized per card so rapid clicks don't race.
    const key = `${event.messageId}:${value.k}:${value.n ?? ""}:${value.f ?? value.r ?? value.d ?? ""}`
    void this.actionSerial
      .run(key, async () => {
        if (value.o && event.operator.openId !== value.o) {
          this.deps.audit.record("card.denied", {
            bot: bot.name,
            chatId: event.chatId,
            operator: event.operator.openId,
            owner: value.o,
            kind: value.k,
          })
          await bot.notifyCardDenied(event.chatId, event.messageId, event.operator.openId, event.operator.name)
          return
        }
        await bindCardOwner(value.o, () => this.processCardAction(bot, event, value))
      })
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
    } else if (value.k === "menu" && value.d) {
      await this.resolveMenuAction(bot, event, value.d)
    } else if (value.k === "make-form" && value.f) {
      await this.resolveMakeForm(bot, event, value.f, value.d)
    } else if (value.k === "make-sub" && value.f) {
      await this.resolveMakeSubmit(bot, event, value.f, value.n, value.d)
    } else if (value.k === "make-refresh" && value.f) {
      await this.resolveMakeRefresh(bot, event, value.f, value.n, value.d)
    } else if (value.k === "make-addfile" && value.f) {
      await this.resolveMakeAddFile(bot, event, value.f, value.n, value.d, "material")
    } else if (value.k === "make-addtpl" && value.f) {
      await this.resolveMakeAddFile(bot, event, value.f, value.n, value.d, "template")
    } else if (value.k === "make-cancel") {
      await this.resolveMakeCancel(bot, event, value.n)
    } else if (value.k === "studio") {
      await this.resolveStudio(bot, event, value)
    } else if (value.k === "login") {
      await this.resolveLogin(bot, event, value)
    } else if (value.k === "skill-mgr") {
      await this.refreshSkillManage(bot, event)
    } else if (value.k === "skill-new") {
      await bot.updateCard(
        event.messageId,
        skillFormCard({}, { isAdmin: this.deps.conversations.isSkillAdmin(event.operator.openId) }),
      )
    } else if (value.k === "skill-edit" && value.d) {
      await this.openSkillForm(bot, event, value.d)
    } else if (value.k === "skill-del" && value.d) {
      const skill = this.deps.conversations.skills.get(event.operator.openId, value.d)
      if (skill) await bot.updateCard(event.messageId, skillDeleteConfirmCard(skill))
    } else if (value.k === "skill-del-yes" && value.d) {
      await this.resolveSkillDelete(bot, event, value.d)
    } else if (value.k === "skill-save") {
      await this.resolveSkillSave(bot, event, value)
    } else if (value.k === "skill-cancel") {
      this.pendingSkillForms.delete(event.messageId)
      await this.refreshSkillManage(bot, event, "已取消，技能没有改动。")
    } else if (value.k === "skill-use" && value.d) {
      await this.resolveSkillUse(bot, event, value.d)
    } else if (value.k === "intel") {
      if (value.d && value.f && value.s) {
        await this.resolveIntel(bot, event, value.d, value.f, value.s)
      } else {
        this.deps.audit.record("intel.stale", {
          reason: "incomplete_callback",
          action: value.d,
          itemId: value.f,
          name: value.s,
        })
      }
    }
  }

  private async resolveMenuAction(bot: FeishuBot, event: CardActionEvent, action: string): Promise<void> {
    if (action === "cron-sub") {
      await bot.updateCard(event.messageId, subscribeCard())
      return
    }
    if (action === "cron-mail-sub") {
      await bot.updateCard(event.messageId, mailSubscribeCard())
      return
    }
    if (action === "cron-mgr") {
      await this.refreshCronManage(bot, event)
    }
  }

  /** 验证码登录：对接玉树 OpenAPI；未注入 studio 时保持本地校验提示。 */
  private async resolveLogin(bot: FeishuBot, event: CardActionEvent, value: CardValue): Promise<void> {
    const form = extractFormValues(event)
    const phone = textOf(form.phone).replace(/\s+/g, "")
    const code = textOf(form.code).trim()
    const draft = { phone, code }
    const studio = this.deps.studio
    if (value.d === "sms") {
      if (!phone) {
        await bot.updateCard(event.messageId, loginCard({ ...draft, notice: "请输入手机号。" }))
        return
      }
      const last = this.smsSentAt.get(event.operator.openId) ?? 0
      const wait = 60_000 - (Date.now() - last)
      if (wait > 0) {
        await bot.updateCard(event.messageId, loginCard({ ...draft, sent: true, notice: `请 ${Math.ceil(wait / 1000)} 秒后再获取验证码。` }))
        return
      }
      if (!studio) {
        await bot.updateCard(event.messageId, loginCard({ ...draft, notice: "创作登录服务未启用。" }))
        return
      }
      try {
        await studio.sendSms(phone)
        this.smsSentAt.set(event.operator.openId, Date.now())
        await bot.updateCard(event.messageId, loginCard({ ...draft, sent: true, notice: "验证码已发送，请查收短信。" }))
      } catch (error) {
        await bot.updateCard(event.messageId, loginCard({ ...draft, notice: studioErrorMessage(error) }))
      }
      return
    }
    if (!studio) {
      await bot.updateCard(event.messageId, loginCard({ ...draft, notice: "创作登录服务未启用。" }))
      return
    }
    try {
      const { account, me } = await studio.login(event.operator.openId, phone, code)
      this.deps.audit.record("studio.login", { openId: event.operator.openId, mobile: account.mobile })
      const pending = studio.takePending(event.operator.openId)
      const points = typeof me.points === "number" ? me.points : undefined
      if (!pending) {
        await bot.updateCard(event.messageId, loginDoneCard(account.mobile, points))
        return
      }
      // 从「海报生成」等入口进来的：登录后继续引导描述，或已有描述则直接生成。
      const nextHint =
        pending.kind === "poster"
          ? pending.prompt
            ? "登录成功，正在按你刚才的描述生成海报…"
            : "登录成功，请在下一张卡片填写海报描述并开始生成。"
          : "登录成功，请继续填写创作内容。"
      await bot.updateCard(event.messageId, loginDoneCard(account.mobile, points, nextHint))
      const filled: StudioDraft = {
        kind: pending.kind,
        prompt: pending.prompt,
        loggedIn: true,
        points,
        notice:
          pending.kind === "poster" && !pending.prompt
            ? "已登录。请填写海报描述，然后点「开始生成」。"
            : undefined,
      }
      if (pending.kind === "poster" && pending.prompt?.trim()) {
        await bot.sendCard(event.chatId, studioPendingCard(), { replyTo: event.messageId })
        try {
          const outcome = await studio.run(event.operator.openId, filled)
          const failed = String(outcome.job.status || "") === "failed"
          await bot.sendCard(
            event.chatId,
            studioResultCard(filled, {
              text: outcome.job.text,
              imageUrls: (outcome.job.images ?? []).map((item) => item.url).filter(Boolean),
              pointsLeft: outcome.pointsLeft,
              dryRun: outcome.job.dry_run,
              error: failed ? outcome.job.message || "生成失败，请稍后重试。" : undefined,
            }),
            { replyTo: event.messageId },
          )
          for (const file of outcome.imageFiles) {
            await bot.sendImage(event.chatId, file, { replyTo: event.messageId }).catch(() => {})
          }
        } catch (error) {
          await bot.sendCard(event.chatId, studioResultCard(filled, { error: studioErrorMessage(error) }), {
            replyTo: event.messageId,
          })
        }
        return
      }
      await bot.sendCard(event.chatId, studioCard(filled), { replyTo: event.messageId })
    } catch (error) {
      await bot.updateCard(event.messageId, loginCard({ ...draft, notice: studioErrorMessage(error) }))
    }
  }

  /** 创作工作台：切换功能 / 提交玉树任务并回写结果。 */
  private async resolveStudio(bot: FeishuBot, event: CardActionEvent, value: CardValue): Promise<void> {
    const saved = studioDraftFrom(value)
    const form = extractFormValues(event)
    const prompt = textOf(form.prompt) || saved.prompt || ""
    const product = textOf(form.product) || saved.product || ""
    const channel = textOf(form.channel) || saved.channel || "淘宝/天猫"
    const language = textOf(form.language) || saved.language || "繁体中文"
    const words = textOf(form.words) || saved.words || "200"
    const scene = textOf(form.scene) || saved.scene || ""
    const selling = textOf(form.selling) || saved.selling || ""
    const platform = textOf(form.platform) || saved.platform || "Twitter"
    const tone = textOf(form.tone) || saved.tone || "广东粤语"
    const picked = value.d === "copy" || value.d === "poster" || value.d === "commerce" ? value.d : undefined
    const kind: StudioKind = picked ?? (value.f === "poster" || value.f === "commerce" || value.f === "copy" ? value.f : "copy")
    const auth = await this.studioAuthDraft(event.operator.openId)
    const filled: StudioDraft = { kind, prompt, product, channel, language, words, scene, selling, platform, tone, ...auth }
    if (value.d === "revise") {
      await bot.updateCard(event.messageId, studioCard({ ...filled, kind: "copy" }))
      return
    }
    if (picked || value.d === "back") {
      await bot.updateCard(event.messageId, studioCard(filled))
      return
    }
    if (kind === "commerce" && !product.trim()) {
      await bot.updateCard(event.messageId, studioCard({ ...filled, notice: "请先填写产品名称。" }))
      return
    }
    if (kind === "copy" && !scene.trim()) {
      await bot.updateCard(event.messageId, studioCard({ ...filled, notice: "请先填写场景需求。" }))
      return
    }
    if (kind === "copy" && !product.trim()) {
      await bot.updateCard(event.messageId, studioCard({ ...filled, notice: "请先填写产品名称。" }))
      return
    }
    if (kind === "copy" && !/^\d+$/.test(words.trim())) {
      await bot.updateCard(event.messageId, studioCard({ ...filled, notice: "输出字数请填数字，例如 200。" }))
      return
    }
    if (kind === "poster" && !prompt.trim()) {
      await bot.updateCard(event.messageId, studioCard({ ...filled, notice: "请先填写描述。" }))
      return
    }
    const studio = this.deps.studio
    if (!studio) {
      await bot.updateCard(event.messageId, studioCard({ ...filled, notice: "创作服务未启用。" }))
      return
    }
    if (!studio.account(event.operator.openId)) {
      await bot.updateCard(event.messageId, studioCard({ ...filled, notice: "尚未登录。请先发送「验证码登录」绑定网页端账号。" }))
      return
    }
    await bot.updateCard(event.messageId, studioPendingCard())
    try {
      const outcome = await studio.run(event.operator.openId, filled)
      const status = String(outcome.job.status || "")
      if (status === "failed") {
        await bot.updateCard(
          event.messageId,
          studioResultCard(filled, {
            error: outcome.job.message || "生成失败，请稍后重试。",
            pointsLeft: outcome.pointsLeft,
            dryRun: outcome.job.dry_run,
          }),
        )
        this.deps.audit.record("studio.job_failed", { openId: event.operator.openId, kind, jobId: outcome.job.job_id })
        return
      }
      const imageUrls = (outcome.job.images ?? []).map((item) => item.url).filter(Boolean)
      await bot.updateCard(
        event.messageId,
        studioResultCard(filled, {
          text: outcome.job.text,
          imageUrls,
          pointsLeft: outcome.pointsLeft,
          dryRun: outcome.job.dry_run,
        }),
      )
      for (const file of outcome.imageFiles) {
        await bot.sendImage(event.chatId, file, { replyTo: event.messageId }).catch((error) => {
          this.deps.logger.warn("Failed to send studio image", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      this.deps.audit.record("studio.job_ok", {
        openId: event.operator.openId,
        kind,
        jobId: outcome.job.job_id,
        images: outcome.imageFiles.length,
        dryRun: outcome.job.dry_run,
      })
    } catch (error) {
      await bot.updateCard(event.messageId, studioResultCard(filled, { error: studioErrorMessage(error) }))
      this.deps.audit.record("studio.job_error", {
        openId: event.operator.openId,
        kind,
        error: studioErrorMessage(error),
      })
    }
  }

  private async studioAuthDraft(openId: string): Promise<Pick<StudioDraft, "points" | "loggedIn">> {
    const studio = this.deps.studio
    if (!studio?.account(openId)) return { loggedIn: false }
    try {
      const me = await studio.me(openId)
      if (!me) return { loggedIn: false }
      return { loggedIn: true, points: typeof me.points === "number" ? me.points : undefined }
    } catch {
      return { loggedIn: true }
    }
  }

  // ---- 个性化技能 ----------------------------------------------------------

  /** 重新渲染技能管理卡；message 非空时在顶部加一行结果说明（取消/删除后回显）。 */
  private async refreshSkillManage(bot: FeishuBot, event: CardActionEvent, message?: string): Promise<void> {
    const openId = event.operator.openId
    const card = skillManageCard(
      this.deps.conversations.skills.list(openId),
      this.deps.conversations.isSkillAdmin(openId),
    )
    if (message) {
      const body = card as { body?: { elements?: unknown[] } }
      body.body?.elements?.unshift({ tag: "markdown", content: `<font color='grey'>${message}</font>` })
    }
    await bot.updateCard(event.messageId, card)
  }

  /** 打开编辑表单：把已有技能回填进表单。 */
  private async openSkillForm(bot: FeishuBot, event: CardActionEvent, id: string): Promise<void> {
    const skill = this.deps.conversations.skills.get(event.operator.openId, id)
    if (!skill) {
      await this.refreshSkillManage(bot, event, "这条技能已经不在了。")
      return
    }
    const draft: SkillFormDraft = {
      id: skill.id,
      name: skill.name,
      triggers: skill.triggers,
      scene: skill.scene,
      steps: skill.steps,
      output: skill.output,
      scope: skill.scope,
    }
    await bot.updateCard(
      event.messageId,
      skillFormCard(draft, { isAdmin: this.deps.conversations.isSkillAdmin(event.operator.openId) }),
    )
  }

  private async resolveSkillDelete(bot: FeishuBot, event: CardActionEvent, id: string): Promise<void> {
    const openId = event.operator.openId
    const removed = this.deps.conversations.skills.remove(openId, id, {
      allowShared: this.deps.conversations.isSkillAdmin(openId),
    })
    if (!removed) {
      await this.refreshSkillManage(bot, event, "这条技能不存在，或你没有权限删除。")
      return
    }
    this.deps.audit.record("skill.deleted", { chatId: event.chatId, operator: openId, skill: removed.name })
    await this.refreshSkillManage(bot, event, `已删除技能「${removed.name}」。`)
  }

  /** 表单提交：校验 → 落盘 → 换成「已保存」卡（带试用按钮）。 */
  private async resolveSkillSave(bot: FeishuBot, event: CardActionEvent, value: CardValue): Promise<void> {
    const openId = event.operator.openId
    const isAdmin = this.deps.conversations.isSkillAdmin(openId)
    const cached = this.pendingSkillForms.get(event.messageId)
    const values = extractFormValues(event)
    const draft: SkillDraft = mergeSkillDraftFromForm(cached, values, value.d ?? cached?.id)
    try {
      const skill = this.deps.conversations.skills.save(openId, draft, {
        allowShared: isAdmin,
        ownerName: event.operator.name,
      })
      this.pendingSkillForms.delete(event.messageId)
      this.deps.audit.record("skill.saved", {
        chatId: event.chatId,
        operator: openId,
        skill: skill.name,
        scope: skill.scope,
        updated: Boolean(draft.id),
      })
      try {
        await bot.updateCard(event.messageId, skillSavedCard(skill, isAdmin))
      } catch {
        await bot
          .sendMarkdown(
            event.chatId,
            `✅ 技能「${skill.name}」已保存。若上方卡片未刷新，请发「技能库」查看。`,
            { replyTo: event.messageId },
          )
          .catch(() => {})
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.audit.record("skill.rejected", {
        chatId: event.chatId,
        operator: openId,
        reason,
        formKeys: formValueKeySummary(event),
        nameLen: draft.name.length,
      })
      // 必须刷新卡片（新 nonce），否则同一张卡第二次点「保存」会被 SDK 去重静默丢弃。
      const draftForForm: SkillFormDraft = {
        id: draft.id,
        name: draft.name,
        triggers: draft.triggers,
        scene: draft.scene,
        steps: draft.steps,
        output: draft.output,
        scope: draft.scope,
      }
      this.pendingSkillForms.set(event.messageId, draftForForm)
      await bot
        .updateCard(
          event.messageId,
          skillFormCard(draftForForm, { isAdmin, errorHint: reason }),
        )
        .catch(async () => {
          await bot
            .sendMarkdown(event.chatId, `⚠️ 没有保存：${reason}\n请发「新建技能」重新打开表单。`, {
              replyTo: event.messageId,
            })
            .catch(() => {})
        })
    }
  }

  /** 「试用」：立刻按这条技能跑一次，让用户看到效果。 */
  private async resolveSkillUse(bot: FeishuBot, event: CardActionEvent, id: string): Promise<void> {
    const skill = this.deps.conversations.skills.get(event.operator.openId, id)
    if (!skill) {
      await this.refreshSkillManage(bot, event, "这条技能已经不在了。")
      return
    }
    await this.deps.conversations.runSkillTrialInChat(
      bot,
      event.chatId,
      event.operator.openId,
      event.operator.name ?? "",
      skill,
      event.messageId,
    )
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
    this.deps.conversations.noteMakeFailure(event.chatId, event.operator.openId, event.messageId)
    await bot.updateCard(
      event.messageId,
      statusCard(
        "⏳ 表单已失效",
        "这张表单已被取代:你之后发起了其他任务,或打开了新的制作表单。\n如需制作,请从菜单重新打开「商业计划书」「产品化请示」或「产品退出评审」。",
        "grey",
      ),
    )
  }

  /**
   * 「添加本地文件」:记下当前表单输入,请用户用原生「+ → 本机文件」发文件;
   * 文件到达后表单卡自动重渲染(已填内容回填、新文件自动勾选),无需手动刷新。 */
  private async resolveMakeAddFile(
    bot: FeishuBot,
    event: CardActionEvent,
    format: string,
    nonce?: number,
    deckRaw?: string,
    accept: "material" | "template" = "material",
  ): Promise<void> {
    const f = format === "pptx" || format === "docx" || format === "pdf" || format === "xlsx" || format === "copy" ? format : undefined
    if (!f) return
    if (!this.deps.conversations.makeFormActive(event.chatId, event.operator.openId, nonce)) {
      await this.rejectStaleMakeForm(bot, event)
      return
    }
    const values = extractFormValues(event)
    const chatType = await this.makeChatType(bot, event.chatId)
    const deck = this.deckOf(f, deckRaw)
    this.deps.conversations.beginMakeUpload(
      event.chatId,
      event.operator.openId,
      event.messageId,
      f,
      {
        instruction: String(values.instruction ?? "").trim() || undefined,
        template: String(values.template ?? "").trim() || undefined,
        cloud: String(values.cloud ?? "").trim() || undefined,
        files: formStringList(values.files)?.filter((key) => key !== MAKE_FORM_FILE_PLACEHOLDER),
      },
      chatType,
      accept,
      deck,
    )
    const hint =
      accept === "template"
        ? "请点输入框左侧 **+ → 本机文件**，发送 .pptx 背景模板（可多份）。收到后只出现在卡片「模板」下拉里，并自动选中最新一份，不会进入资料文件。已填写的指令不会丢。"
        : "请点输入框左侧 **+ → 本机文件**,选好文件发送(可多选)。收到后表单会自动更新并勾选,已填写的指令不会丢。"
    await bot.sendMarkdown(event.chatId, hint, { replyTo: event.messageId }).catch(() => {})
  }

  private deckOf(format: string, raw: string | undefined): DeckTask | undefined {
    if (format !== "pptx") return undefined
    return parseDeckTask(raw) ?? "business-plan"
  }

  /**
   * 「刷新文件列表」:带着当前表单输入重渲染——已填内容回填,刚拖进聊天的
   * 新文件(近 2 分钟入缓存)自动勾选,免去找回的麻烦。 */
  private async resolveMakeRefresh(bot: FeishuBot, event: CardActionEvent, format: string, nonce?: number, deckRaw?: string): Promise<void> {
    const f = format === "pptx" || format === "docx" || format === "pdf" || format === "xlsx" || format === "copy" ? format : undefined
    if (!f) return
    if (!this.deps.conversations.makeFormActive(event.chatId, event.operator.openId, nonce)) {
      await this.rejectStaleMakeForm(bot, event)
      return
    }
    const chatType = await this.makeChatType(bot, event.chatId)
    const deck = this.deckOf(f, deckRaw)
    const values = extractFormValues(event)
    let data = this.deps.conversations.makeFormData(bot, event.chatId, event.operator.openId, f, chatType, deck)
    const checked = new Set(formStringList(values.files)?.filter((key) => key !== MAKE_FORM_FILE_PLACEHOLDER) ?? [])
    const now = Date.now()
    for (const file of data.files) {
      const savedAt = Number(/^(\d+)_/.exec(file.value)?.[1] ?? 0)
      if (savedAt > 0 && now - savedAt < 60 * 60_000) checked.add(file.value)
    }
    let preset = {
      instruction: String(values.instruction ?? "").trim() || undefined,
      template: String(values.template ?? "").trim() || undefined,
      cloud: String(values.cloud ?? "").trim() || undefined,
      files: [...checked].filter((key) => data.files.some((file) => file.value === key)),
    }
    this.deps.conversations.rememberMakeFormCard(
      event.chatId,
      event.operator.openId,
      event.messageId,
      f,
      chatType,
      preset,
      deck,
    )
    const result = await this.deps.conversations.refreshMakeFormFiles(
      bot,
      event.chatId,
      event.operator.openId,
      chatType,
      f,
      preset,
      event.messageId,
      "refresh",
      deck,
    )
    const replyTo = result.messageId
    if (result.count === 0) {
      await bot
        .sendMarkdown(
          event.chatId,
          "还没检测到可选文件。请先 **+ → 本机文件** 发送，等「已收到文件」提示后，再点一次「刷新文件列表」。",
          { replyTo },
        )
        .catch(() => {})
      return
    }
    if (result.mode === "republished") {
      const hint =
        result.labels.length > 0
          ? `本卡片无法原地刷新，已补发制作卡。最近上传：**${result.labels.join("、")}**。请在新卡片 **「资料文件」** 里勾选。`
          : `已补发制作卡，共 ${result.count} 个文件可选。请在新卡片 **「资料文件」** 下拉里勾选。`
      await bot.sendMarkdown(event.chatId, hint, { replyTo }).catch(() => {})
    } else if (result.labels.length > 0) {
      await bot
        .sendMarkdown(
          event.chatId,
          `已刷新。最近上传：**${result.labels.join("、")}**。请在 **「资料文件」** 下拉框勾选后点「开始生成」。`,
          { replyTo },
        )
        .catch(() => {})
    }
  }

  /** 品类按钮 → 原卡原地换成对应制作表单。 */
  private async resolveMakeForm(bot: FeishuBot, event: CardActionEvent, format: string, deckRaw?: string): Promise<void> {
    const f = format === "pptx" || format === "docx" || format === "pdf" ? format : undefined
    if (!f) return
    const chatType = await this.makeChatType(bot, event.chatId)
    const deck = this.deckOf(f, deckRaw)
    const data = this.deps.conversations.makeFormData(bot, event.chatId, event.operator.openId, f, chatType, deck)
    const nonce = this.deps.conversations.issueMakeForm(event.chatId, event.operator.openId)
    this.deps.conversations.rememberMakeFormCard(event.chatId, event.operator.openId, event.messageId, f, chatType, undefined, deck)
    await bot.updateCard(event.messageId, makeFormCard(data, undefined, nonce))
  }

  private async makeChatType(bot: FeishuBot, chatId: string): Promise<"p2p" | "group"> {
    const chat = await bot.getChatInfo(chatId).catch(() => undefined)
    return String((chat as { chatType?: string } | undefined)?.chatType ?? "p2p") === "group" ? "group" : "p2p"
  }

  /** 制作表单提交:校验 → 组装任务 → 原卡换成确认卡,生成走正常流式流程。 */
  private async resolveMakeSubmit(bot: FeishuBot, event: CardActionEvent, format: string, nonce?: number, deckRaw?: string): Promise<void> {
    const f = format === "pptx" || format === "docx" || format === "pdf" || format === "xlsx" || format === "copy" ? format : undefined
    if (!f) return
    if (!this.deps.conversations.makeFormActive(event.chatId, event.operator.openId, nonce)) {
      await this.rejectStaleMakeForm(bot, event)
      return
    }
    const values = extractFormValues(event)
    const instruction = String(values.instruction ?? "").trim()
    const pickedFiles = formStringList(values.files)
      ?.map((key) => key.trim())
      .filter((key) => key.length > 0 && key !== MAKE_FORM_FILE_PLACEHOLDER)
    const fileKeys =
      pickedFiles ??
      this.deps.conversations
        .currentMakeFiles(event.chatId, event.operator.openId)
        .filter((key) => key !== MAKE_FORM_FILE_PLACEHOLDER)
    const rawTemplate = "template" in values ? String(values.template ?? "").trim() : ""
    const remembered = this.deps.conversations.currentMakeTemplate(event.chatId, event.operator.openId)
    const template = rawTemplate === "none" ? "" : rawTemplate || (remembered === "none" ? "" : remembered)
    const cloud = String(values.cloud ?? "").trim()
    const scenario = String(values.scenario ?? "").trim() || undefined
    const chat = await bot.getChatInfo(event.chatId).catch(() => undefined)
    const chatType = String((chat as { chatType?: string } | undefined)?.chatType ?? "p2p")
    const deck = this.deckOf(f, deckRaw)
    const data = this.deps.conversations.makeFormData(
      bot,
      event.chatId,
      event.operator.openId,
      f,
      chatType === "group" ? "group" : "p2p",
      deck,
    )
    const fileByName = new Map(data.files.flatMap((file) => [[file.value, file.value], [file.label, file.value]] as const))
    const resolvedKeys = fileKeys.map((key) => fileByName.get(key) ?? key)
    const missing: string[] = []
    if (instruction.length < 4) missing.push("请填写具体指令（至少 4 个字）")
    if (f === "pptx" && resolvedKeys.length === 0 && !cloud) {
      missing.push(
        data.files.length === 0
          ? "请先点「添加本地文件」发送材料，再在「资料文件」里勾选"
          : "请在「资料文件」里勾选至少一份材料",
      )
    }
    const preset: MakeFormPreset = {
      instruction: instruction || undefined,
      template: template || undefined,
      cloud: cloud || undefined,
      files: resolvedKeys,
    }
    if (missing.length > 0) {
      await this.keepMakeForm(bot, event, f, chatType === "group" ? "group" : "p2p", deck, data, preset, missing.join("；"))
      return
    }
    const result = await this.deps.conversations.submitMake(bot, {
      chatId: event.chatId,
      chatType: chatType === "group" ? "group" : "p2p",
      senderId: event.operator.openId,
      format: f,
      instruction,
      fileKeys: resolvedKeys,
        template: template || "",
      cloud,
      scenario,
      deck,
    })
    if (!result.ok) {
      await this.keepMakeForm(
        bot,
        event,
        f,
        chatType === "group" ? "group" : "p2p",
        deck,
        data,
        preset,
        result.error,
      )
      return
    }
    this.deps.conversations.revokeMakeForm(event.chatId, event.operator.openId)
    this.deps.conversations.clearMakeErrorCard(event.messageId)
    const dismissed = this.deps.conversations.dismissMakeFailures(
      bot,
      event.chatId,
      event.operator.openId,
      event.messageId,
    )
    try {
      await bot.updateCard(event.messageId, makeSubmittedCard(f, instruction, result.fileCount, result.templateLabel, scenario, deck))
    } catch (error) {
      this.deps.logger.warn("Failed to replace make form after submit", { error: message(error) })
    }
    result.start()
    await dismissed
  }

  /** 缺必填项时留在原卡片上，换新按钮编号，避免第二次提交被飞书去重丢掉。 */
  private async keepMakeForm(
    bot: FeishuBot,
    event: CardActionEvent,
    format: MakeFormat,
    chatType: "p2p" | "group",
    deck: DeckTask | undefined,
    data: MakeFormData,
    preset: MakeFormPreset,
    reason: string,
  ): Promise<void> {
    const nonce = this.deps.conversations.rollMakeFormNonce(event.chatId, event.operator.openId)
    this.deps.conversations.rememberMakeFormCard(
      event.chatId,
      event.operator.openId,
      event.messageId,
      format,
      chatType,
      preset,
      deck,
    )
    this.deps.audit.record("make.rejected", {
      chatId: event.chatId,
      operator: event.operator.openId,
      reason,
      picked: preset.files?.length ?? 0,
    })
    this.deps.conversations.markMakeErrorCard(event.messageId)
    await bot
      .updateCard(event.messageId, makeFormCard(data, preset, nonce, { errorHint: reason }))
      .catch(async () => {
        const sent = await bot
          .sendMarkdown(event.chatId, `⚠️ ${reason}\n请在原卡片上改完，再点「开始生成」。`, {
            replyTo: event.messageId,
          })
          .catch(() => undefined)
        const noticeId = messageIdOf(sent)
        if (noticeId) this.deps.conversations.noteMakeFailure(event.chatId, event.operator.openId, noticeId)
      })
  }

  private async refreshCronManage(bot: FeishuBot, event: CardActionEvent): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron) {
      await bot.sendText(event.chatId, "定时任务未启用。")
      return
    }
    await bot.updateCard(event.messageId, cronManageCard(cron.listFor(event.operator.openId, event.chatId)))
  }

  private async resolveCronToggle(bot: FeishuBot, event: CardActionEvent, name: string): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron || !this.ownJob(cron, event, name)) {
      await bot.sendText(event.chatId, `未找到订阅「${name}」`)
      return
    }
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
    if (!cron || !this.ownJob(cron, event, name)) {
      await bot.sendText(event.chatId, `未找到订阅「${name}」`)
      return
    }
    const urgent = cron.toggleUrgent(name)
    if (urgent === undefined) {
      await bot.sendText(event.chatId, `未找到订阅「${name}」`)
      return
    }
    await this.refreshCronManage(bot, event)
  }

  private async resolveCronRemove(bot: FeishuBot, event: CardActionEvent, name: string): Promise<void> {
    const cron = this.deps.getCron?.()
    const job = cron ? this.ownJob(cron, event, name) : undefined
    if (!cron || !job) {
      await bot.sendText(event.chatId, `未找到订阅「${name}」`)
      return
    }
    if (isMailJob(job)) this.deps.getMailBinding?.()?.clearDelivery(event.operator.openId)
    await cron.remove(name)
    await this.refreshCronManage(bot, event)
  }

  /** 编辑 = 原卡换成预填的订阅表单;提交走 cron-sub/cron-mail-sub,value.f 带旧名用于替换。 */
  private async resolveCronEdit(bot: FeishuBot, event: CardActionEvent, name: string): Promise<void> {
    const cron = this.deps.getCron?.()
    if (!cron) return
    const job = this.ownJob(cron, event, name)
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

  private ownJob(cron: CronController, event: CardActionEvent, name: string): CronJobInfo | undefined {
    return cron.listFor(event.operator.openId, event.chatId).find((job) => job.name === name)
  }

  /**
   * 邮件订阅按飞书用户隔离。第一次提交必须带上自己的邮箱；编辑已有订阅只改频率和时间，
   * 沿用已经绑定的邮箱。任务名按用户区分，避免后订阅的人覆盖别人的任务。
   */
  private async resolveMailSubscribe(bot: FeishuBot, event: CardActionEvent, value: CardValue): Promise<void> {
    const cron = this.deps.getCron?.()
    const store = this.deps.getMailBinding?.()
    if (!cron || !store) {
      await bot.sendText(event.chatId, "定时任务未启用。")
      return
    }
    const values = extractFormValues(event)
    const freqKey = String(values.freq ?? "")
    const freq = FREQ_TABLE[freqKey]
    const hour = Number(values.hour)
    const minute = Number(values.minute)
    const editing = value.f ? this.ownJob(cron, event, value.f) : undefined
    const reopen = (notice: string) => bot.updateCard(event.messageId, mailSubscribeCard(editing ? { name: editing.name, schedule: editing.schedule } : undefined, notice))
    if (!freq || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      await reopen("请选择总结频率、小时和分钟。")
      return
    }
    const openId = event.operator.openId
    let email = store.get(openId)?.email ?? ""
    if (!editing) {
      email = textOf(values.email).trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await reopen("请填写你的飞书邮箱。")
        return
      }
      const actual = await lookupUserEmail(bot, openId).catch(() => "")
      if (!actual) {
        await reopen("没能从飞书通讯录查到你的企业邮箱，请联系管理员核对后再订阅。")
        return
      }
      if (email.toLowerCase() !== actual.toLowerCase()) {
        await reopen(`只能填写你飞书账号登记的邮箱：${actual}`)
        return
      }
      if (store.takenByOther(actual, openId)) {
        await reopen("这个邮箱已经绑定在另一个飞书账号上。")
        return
      }
      email = actual
      store.set(openId, email, { chatId: event.chatId, bot: bot.name })
      cron.resumeMailJobsForOwner(openId)
    } else if (!email) {
      await bot.updateCard(event.messageId, mailSubscribeCard(undefined, "还没有绑定邮箱，请重新填写。"))
      return
    } else {
      store.touchDelivery(openId, event.chatId, bot.name)
    }
    const saved = store.get(openId)
    if (!saved) {
      await reopen("还没有绑定邮箱，请重新填写。")
      return
    }
    const chat = await bot.getChatInfo(event.chatId).catch(() => undefined)
    const chatType = String((chat as { chatType?: string } | undefined)?.chatType ?? "p2p") === "group" ? "group" : "p2p"
    this.deps.conversations.plantMailScope(bot, event.chatId, openId, chatType)
    const name = editing?.name ?? cron.listFor(openId, event.chatId).find((job) => isMailJob(job))?.name ?? mailJobName(openId)
    const days = FREQ_DAYS[freqKey] ?? 1
    const identity: ChatIdentity = {
      chatId: event.chatId,
      chatType,
      senderId: openId,
      senderName: event.operator.name ?? "user",
    }
    const result = await cron.add(
      [name, String(minute), String(hour), freq.dom, "*", freq.dow, buildMailDigestPrompt(days, saved.email)],
      identity,
      bot.name,
    )
    this.deps.audit.record("cron.subscribe_card", { bot: bot.name, chatId: event.chatId, name, operator: openId, edit: editing?.name, kind: "mail" })
    await bot.updateCard(
      event.messageId,
      statusCard(
        "📮 邮件管理已开启",
        `${result}\n邮箱：**${saved.email}**\n每次总结过去 **${days} 天**的收件箱，只读这个邮箱。重要性「高」的新邮件实时单独推送。`,
        "green",
      ),
    )
  }

  /** 情报档案按钮：追踪改原卡；竞标/成本/竞品在下面跟一条带出处的结果卡。 */
  private async resolveIntel(bot: FeishuBot, event: CardActionEvent, action: string, itemId: string, jobName: string): Promise<void> {
    const intel = this.deps.getIntel?.()
    const cron = this.deps.getCron?.()
    if (!intel || !cron) {
      await bot.sendCardResilient(event.chatId, statusCard("情报档案", "这条订阅已经不在了，按钮无法继续。", "orange"), {
        replyTo: event.messageId,
      })
      this.deps.audit.record("intel.stale", { name: jobName, itemId, action, reason: "no_store" })
      return
    }
    // 订阅改名后，飞书里旧卡按钮仍带旧名字；用条目 id 找回现行档案与任务。
    let archiveName = jobName
    let job = cron.find(jobName)
    if (!job || !intel.getItem(jobName, itemId)) {
      const mapped = intel.findArchiveForItem(itemId)
      if (mapped) {
        archiveName = mapped
        job = cron.find(mapped) ?? job
      }
    }
    if (!job) {
      await bot.sendCardResilient(event.chatId, statusCard("情报档案", "这条订阅已经不在了，按钮无法继续。", "orange"), {
        replyTo: event.messageId,
      })
      this.deps.audit.record("intel.stale", { name: jobName, archiveName, itemId, action, reason: "job_missing" })
      return
    }
    if (action === "exclude") {
      intel.exclude(archiveName, itemId)
      const saved = intel.delivery(archiveName, event.messageId)
      if (saved) {
        await bot.updateCard(
          event.messageId,
          intelDigestCard(job.name, saved.items, saved.nextLabel, saved.lockedIds),
        )
      }
      this.deps.audit.record("intel.exclude", { name: job.name, itemId, operator: event.operator.openId, from: jobName })
      return
    }
    if (action === "track") {
      const item = intel.getItem(archiveName, itemId)
      if (!item || item.status === "excluded") return
      const entity =
        item.subjectEntity?.trim() ||
        item.matchedTrackedEntity?.trim() ||
        item.title.replace(/\s+/g, " ").trim().slice(0, 40)
      if (entity) intel.addTrackedEntities(archiveName, [entity])
      intel.lockDeliveryItem(archiveName, event.messageId, itemId)
      const saved = intel.delivery(archiveName, event.messageId)
      if (saved) {
        await bot.updateCard(
          event.messageId,
          intelDigestCard(job.name, saved.items, saved.nextLabel, saved.lockedIds),
        )
      }
      this.deps.audit.record("intel.track", {
        name: job.name,
        itemId,
        entity,
        operator: event.operator.openId,
        from: jobName,
      })
      return
    }
    if (action !== "cost" && action !== "compete" && action !== "plan") return
    const item = intel.getItem(archiveName, itemId)
    if (!item || item.status === "excluded") {
      this.deps.audit.record("intel.stale", { name: job.name, itemId, action, reason: "item_missing" })
      return
    }
    const scene: IntelScene = action
    const cardTitle =
      scene === "cost" ? "💰 成本与排期" : scene === "compete" ? "⚔️ 竞品差距" : "🎯 竞标策略"
    // 跟帖进本会话流式生成；定时检索仍走侧会话 pregenerate。
    const prompt = intelActionPrompt(
      scene,
      job.name,
      item,
      action === "compete" ? intel.recent(archiveName) : [],
      intel.trackedEntities(archiveName),
    )
    const productContext = detectProductContext(bot.name, `${job.name}\n${prompt}`)
    const finalPrompt = productContext ? buildProductContextPrompt(prompt, productContext) : prompt
    try {
      await this.deps.conversations.runInChat(bot, job.chatId, finalPrompt, {
        userId: job.userId,
        userOpenId: job.ownerOpenId ?? event.operator.openId,
        replyTo: event.messageId,
        cardTitle,
        agent: "pm-a81-opportunity",
      })
      this.deps.audit.record("intel.action", { name: job.name, action, itemId, from: jobName })
    } catch (error) {
      this.deps.logger.warn("Intel action failed", {
        action,
        name: job.name,
        error: error instanceof Error ? error.message : String(error),
      })
      await bot
        .sendCardResilient(
          event.chatId,
          statusCard(cardTitle, "这次没有生成出内容。订阅仍然有效，可以过一会儿再点一次。", "orange"),
          { replyTo: event.messageId },
        )
        .catch(() => {})
      this.deps.audit.record("intel.action_empty", { name: job.name, action, itemId })
    }
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
    // 编辑：先卸旧任务（保留档案）→ 档案跟到新名 → 再按新配置落盘。
    // 之后列表/暂停/删除/推送/按钮跟帖一律只认编辑后的订阅。
    const editing = value.f?.trim()
    let suffix = ""
    if (editing) {
      const owned = this.ownJob(cron, event, editing)
      if (!owned) {
        await bot.updateCard(
          event.messageId,
          statusCard("⚠️ 无法保存", `原订阅 **${editing}** 不存在或无权编辑。请打开「我的订阅」再试。`, "orange"),
        )
        return
      }
      await cron.remove(editing, { keepIntel: true })
      if (editing !== name) {
        this.deps.getIntel?.()?.rename(editing, name)
        suffix = `\n已用 **${name}** 替换 **${editing}**。之后增删改查都按新订阅执行。`
      } else {
        suffix = `\n已更新 **${name}**。之后增删改查都按本次保存的内容与时间执行。`
      }
    }
    const result = await cron.add(
      [name, String(minute), String(hour), freq.dom, "*", freq.dow, prompt],
      identity,
      bot.name,
    )
    this.deps.audit.record("cron.subscribe_card", {
      bot: bot.name,
      chatId: event.chatId,
      name,
      operator: event.operator.openId,
      edit: editing || undefined,
    })
    await bot.updateCard(event.messageId, statusCard("⏰ 订阅结果", result + suffix, "green"))
  }

  /** An old gap-fill card. New turns no longer send one; missing text is a chat reply. */
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
    const pending = await client.pendingPermissions(sessionID).catch(() => [])
    const request = pending.find((item) => item.id === requestID)
    if (request?.resources.some((resource) => isProtectedConfigTarget(resource))) decision = "reject"
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
  async answer(sessionID: string, args: string, operatorOpenId?: string): Promise<string> {
    const pending = [...this.pendingForms.values()].find((p) => p.form.sessionID === sessionID)
    if (!pending) return "当前没有待回答的问题。"
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    let target = pending
    const first = tokens[0]
    if (first && this.pendingForms.has(first)) {
      target = this.pendingForms.get(first) as PendingForm
      tokens.shift()
    }
    const owner = target.context.userOpenId
    if (owner && operatorOpenId && owner !== operatorOpenId) {
      return "这张提问只有发起人可以回答。需要自己用时，请 @ 机器人重新发起。"
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

function messageIdOf(sent: unknown): string | undefined {
  if (!sent || typeof sent !== "object") return undefined
  const row = sent as { messageId?: unknown; message_id?: unknown }
  const id = row.messageId ?? row.message_id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function studioErrorMessage(error: unknown): string {
  if (error instanceof StudioApiError) return error.message
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

function textOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function studioDraftFrom(value: CardValue): StudioDraft {
  const raw = value.v
  const saved = raw && typeof raw === "object" ? (raw as { prompt?: unknown; product?: unknown; channel?: unknown; language?: unknown; words?: unknown; scene?: unknown; selling?: unknown; platform?: unknown; tone?: unknown }) : {}
  const kind: StudioKind = value.f === "poster" || value.f === "commerce" || value.f === "copy" ? value.f : "copy"
  return {
    kind,
    prompt: textOf(saved.prompt),
    product: textOf(saved.product),
    channel: textOf(saved.channel),
    language: textOf(saved.language),
    words: textOf(saved.words),
    scene: textOf(saved.scene),
    selling: textOf(saved.selling),
    platform: textOf(saved.platform),
    tone: textOf(saved.tone),
  }
}

function parseCardCallbackValue(raw: unknown): CardValue | undefined {
  let value: unknown = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== "object" || !("k" in value)) return undefined
  return value as CardValue
}

function mergeSkillDraftFromForm(
  cached: SkillFormDraft | undefined,
  values: Record<string, unknown>,
  id?: string,
): SkillDraft {
  const name =
    formFieldString(values.skill_name ?? values.name).trim() || (cached?.name ?? "").trim()
  const triggersText =
    formFieldString(values.triggers).trim() ||
    (cached?.triggers?.length ? cached.triggers.join(" ") : "")
  const scene = formFieldString(values.scene).trim() || (cached?.scene ?? "").trim()
  const steps = formFieldString(values.steps).trim() || (cached?.steps ?? "").trim()
  const output = formFieldString(values.output).trim() || (cached?.output ?? "").trim()
  const scopeRaw = formFieldString(values.scope).trim() || cached?.scope
  return {
    id,
    name,
    triggers: parseTriggers(triggersText),
    scene,
    steps,
    output,
    scope: scopeRaw === "shared" ? "shared" : "personal",
  }
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
