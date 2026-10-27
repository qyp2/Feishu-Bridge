import fs from "node:fs"
import path from "node:path"
import type { AppConfig } from "../config/index.js"
import type { ConversationService } from "../core/conversations.js"
import type { AuditLog, Logger } from "../util/logger.js"
import { markdownCard } from "../feishu/cards.js"
import type { MailBindingStore } from "../mail/binding.js"

export interface MailWatchDeps {
  config: AppConfig
  conversations: ConversationService
  logger: Logger
  audit: AuditLog
  storageDir: string
  binding: MailBindingStore
}

interface MailMessage {
  message_id?: string
  subject?: string
  /** ms-since-epoch as a decimal string */
  internal_date?: string
  /** UNREAD = unread, IMPORTANT = starred */
  label_ids?: string[]
  from?: unknown
  to?: unknown
  /** base64-encoded bodies at the top level (not nested under body) */
  body_html?: string
  body_plain_text?: string
  attachments?: { filename?: string; name?: string }[]
}

interface SeenFile {
  mailbox: string
  ids: string[]
}

const API = "https://open.feishu.cn/open-apis"
const MAX_SEEN = 500
const MAX_NEW_PER_TICK = 3
const BODY_CHARS = 1500
/** Retry delay while the mailbox address has not been provided anywhere yet. */
const RETRY_NO_MAILBOX_MS = 60_000

/**
 * Polls the user's Feishu mailbox and pushes truly important mail to the chat.
 * New messages are triaged silently through the agent (pregenerate: no card,
 * no streaming); only a 「高」 verdict produces a message, everything else is
 * logged to audit and left for the morning digest.
 */
export class MailWatcher {
  private timer?: NodeJS.Timeout
  private retryTimer?: NodeJS.Timeout
  private ticking = false
  private tokenCache?: { token: string; expire: number }
  private seen = new Set<string>()
  /** True once the inbox baseline was captured (even when it was empty). */
  private seededOnce = false
  private readonly seenFile: string

  constructor(private readonly deps: MailWatchDeps) {
    this.seenFile = path.join(deps.storageDir, "mail-seen.json")
  }

  /**
   * The address comes from bridge config (admin-set, trusted) or from the
   * bridge-owned binding store — written ONLY by the bot 「绑定邮箱」 command
   * after contact-API ownership verification. Nothing on the agent side can
   * redirect the watcher to someone else's mailbox.
   */
  private mailbox(): string {
    const configured = this.deps.config.mail.mailbox
    if (configured) return configured
    return this.deps.binding.get()?.email ?? ""
  }

  start(): void {
    const mail = this.deps.config.mail
    if (!mail.enabled || this.timer || this.retryTimer) return
    if (!mail.chatId) {
      this.deps.logger.warn("Mail watch enabled but chatId missing; disabled")
      return
    }
    const mailbox = this.mailbox()
    if (!mailbox) {
      this.deps.logger.info("Mail watch waiting for a mailbox address (chat config or bridge config)")
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        this.start()
      }, RETRY_NO_MAILBOX_MS)
      this.retryTimer.unref?.()
      return
    }
    this.loadSeen()
    void this.seed().then(() => {
      this.timer = setInterval(() => void this.tick(), mail.intervalMinutes * 60_000)
      this.timer.unref?.()
      this.deps.logger.info("Mail watch started", { mailbox, intervalMinutes: mail.intervalMinutes })
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.timer = undefined
    this.retryTimer = undefined
  }

  /** First run: mark the current inbox as seen so history never floods the chat. */
  private async seed(): Promise<void> {
    if (this.seededOnce) return
    try {
      const ids = await this.listMessages(20)
      for (const id of ids) this.seen.add(id)
      this.seededOnce = true
      this.persistSeen()
      this.deps.audit.record("mailwatch.seeded", { count: ids.length })
    } catch (error) {
      this.deps.logger.warn("Mail watch seed failed; will retry next tick", { error: message(error) })
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      // Without a baseline (e.g. permissions were granted after startup) the
      // whole inbox looks new: seed first and start watching from the next tick.
      if (!this.seededOnce) {
        await this.seed()
        return
      }
      const ids = await this.listMessages(10)
      const fresh = ids.filter((id) => !this.seen.has(id))
      // Oldest first, capped so a backlog can never burst-spam the chat.
      const batch = fresh.reverse().slice(0, MAX_NEW_PER_TICK)
      for (const id of batch) {
        this.seen.add(id)
        await this.triage(id).catch((error) => {
          this.deps.logger.warn("Mail triage failed", { id, error: message(error) })
        })
      }
      // Known ids from this page stay marked even beyond the batch cap.
      for (const id of fresh) this.seen.add(id)
      if (batch.length > 0) this.persistSeen()
    } catch (error) {
      this.deps.logger.warn("Mail watch tick failed", { error: message(error) })
    } finally {
      this.ticking = false
    }
  }

  /** Silent agent verdict; a 「高」 line pushes the card, anything else vanishes into audit. */
  private async triage(id: string): Promise<void> {
    const mail = this.deps.config.mail
    const bot = this.deps.conversations.getBot(mail.bot)
    if (!bot) return
    const detail = await this.getMessage(id)
    const starred = detail.label_ids?.includes("IMPORTANT") ? "★" : ""
    const subject = text(detail.subject) || "(无主题)"
    const from = addressList(detail.from)
    const date = formatDate(detail.internal_date)
    const body = plainBody(detail).slice(0, BODY_CHARS)
    const attachments = (detail.attachments ?? []).map((a) => a.filename ?? a.name).filter(Boolean).join(", ")

    const prompt = [
      "你是邮件重要性分类器。按这三档判断一封新到邮件，标准：",
      "- 高：直接发给本人且需要尽快响应的事项：关键客户/合作伙伴来函、领导交办、合同/付款/报价、截止日期临近的催促、投诉或故障。",
      "- 中：与业务相关但不必立即处理：一般往来、会议纪要、订阅的行业资讯里有价值的内容。",
      "- 低：营销推广、系统通知、自动抄送、与本人职责无关的群发。",
      "第一行只写 [MAIL-IMPORTANCE:高] 或 [MAIL-IMPORTANCE:中] 或 [MAIL-IMPORTANCE:低]，空一格后接不超过 40 字的理由。",
      "第二行起写 2-3 句中文摘要（客观、保留专有名词和数字）。不要写其他内容。",
      "",
      `主题：${starred}${subject}`,
      from ? `发件人：${from}` : "（接口不返回发件人字段；如正文引用头里有寄件者信息，可据此判断）",
      `日期：${date}`,
      attachments ? `附件：${attachments}` : "",
      `正文：${body || "(无正文)"}`,
    ].filter(Boolean).join("\n")

    const reply = await this.deps.conversations.pregenerate(bot, mail.chatId, prompt, undefined, mail.ownerOpenId || undefined)
    const match = /^\[MAIL-IMPORTANCE:(高|中|低)\]\s*(.*)$/m.exec(reply ?? "")
    const level = (match?.[1] ?? "中") as "高" | "中" | "低"
    const reason = (match?.[2] ?? "").trim()
    const summary = (reply ?? "").replace(/^\[MAIL-IMPORTANCE:(高|中|低)\].*$/m, "").trim()
    this.deps.audit.record("mailwatch.triaged", { id, level, reason, subject })

    if (level !== "高") return
    const lines = [`**${starred}${subject}**`]
    if (from) lines.push(`发件人：${from}`)
    lines.push(`时间：${date}`, `判断：${reason}`, "", summary || "(摘要缺失)")
    const card = markdownCard("📨 重要邮件", lines.join("\n"))
    const sent = await bot.sendCard(mail.chatId, card)
    if (mail.ownerOpenId && sent?.messageId) {
      await bot.urgentApp(sent.messageId, [mail.ownerOpenId]).catch(() => {})
    }
    this.deps.audit.record("mailwatch.pushed", { id, subject })
  }

  // ---- Feishu mail API (tenant token, same credentials as the bot) --------

  private async token(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expire > Date.now() + 5 * 60_000) return this.tokenCache.token
    const botConfig = this.deps.config.bots.find((bot) => bot.name === this.deps.config.mail.bot) ?? this.deps.config.bots[0]
    if (!botConfig) throw new Error("no bot configured for mail watch credentials")
    const resp = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: botConfig.appId, app_secret: botConfig.appSecret }),
    })
    const data = (await resp.json()) as { code: number; msg: string; tenant_access_token?: string; expire?: number }
    if (data.code !== 0 || !data.tenant_access_token) throw new Error(`token rejected: ${data.msg}`)
    this.tokenCache = { token: data.tenant_access_token, expire: Date.now() + (data.expire ?? 7200) * 1000 }
    return this.tokenCache.token
  }

  private async api(pathname: string): Promise<Record<string, unknown>> {
    const resp = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${await this.token()}` } })
    const data = (await resp.json()) as { code: number; msg: string; data?: Record<string, unknown> }
    if (data.code !== 0) throw new Error(`mail API ${pathname} -> ${data.code}: ${data.msg}`)
    return data.data ?? {}
  }

  /** The list endpoint returns bare message_id strings, not message objects. */
  private async listMessages(size: number): Promise<string[]> {
    const mailbox = encodeURIComponent(this.mailbox())
    const data = await this.api(`/mail/v1/user_mailboxes/${mailbox}/messages?page_size=${size}&folder_id=INBOX`)
    return ((data.items as unknown[]) ?? [])
      .map((item) => (typeof item === "string" ? item : (item as MailMessage)?.message_id))
      .filter((id): id is string => Boolean(id))
  }

  private async getMessage(id: string): Promise<MailMessage> {
    const mailbox = encodeURIComponent(this.mailbox())
    const data = await this.api(`/mail/v1/user_mailboxes/${mailbox}/messages/${encodeURIComponent(id)}`)
    // The detail payload lives under `message` (older code assumed `item`).
    return ((data.message as MailMessage | undefined) ?? (data.item as MailMessage | undefined) ?? data) as MailMessage
  }

  // ---- seen-id persistence ---------------------------------------------------

  private loadSeen(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.seenFile, "utf8")) as SeenFile
      if (data.mailbox === this.mailbox()) {
        for (const id of data.ids ?? []) if (typeof id === "string" && id) this.seen.add(id)
        if (this.seen.size > 0) this.seededOnce = true
      }
    } catch {
      /* first run */
    }
  }

  private persistSeen(): void {
    const ids = [...this.seen].slice(-MAX_SEEN)
    const data: SeenFile = { mailbox: this.mailbox(), ids }
    fs.writeFileSync(this.seenFile, JSON.stringify(data), "utf8")
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function addressList(value: unknown): string {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items
    .map((item) => {
      const entry = item as { mail_address?: string; address?: string; name?: string }
      return entry?.mail_address ?? entry?.address ?? entry?.name ?? ""
    })
    .filter(Boolean)
    .join(", ")
}

function formatDate(value: unknown): string {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return ""
  return new Date(ms).toLocaleString("zh-CN", { hour12: false })
}

/** Bodies arrive base64-encoded at the message top level. */
function b64decode(value: unknown): string {
  try {
    return Buffer.from(String(value ?? ""), "base64").toString("utf8")
  } catch {
    return ""
  }
}

function plainBody(detail: MailMessage): string {
  const plain = text(b64decode(detail.body_plain_text))
  if (plain) return plain
  return b64decode(detail.body_html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
