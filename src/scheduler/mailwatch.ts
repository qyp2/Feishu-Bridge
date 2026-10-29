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
  mailbox?: string
  ids?: string[]
  boxes?: Record<string, string[]>
}

interface MailTarget {
  email: string
  chatId: string
  ownerOpenId: string
  bot: string
}

const API = "https://open.feishu.cn/open-apis"
const MAX_SEEN = 500
const MAX_NEW_PER_TICK = 3
const BODY_CHARS = 1500

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
  private readonly seen = new Map<string, Set<string>>()
  private readonly seeded = new Set<string>()
  private readonly seenFile: string

  constructor(private readonly deps: MailWatchDeps) {
    this.seenFile = path.join(deps.storageDir, "mail-seen.json")
  }

  /**
   * Each subscribed user is polled on their own mailbox and delivered to their
   * own chat. The config mailbox is only a fallback for the original binding
   * that has not stored a delivery chat yet.
   */
  private targets(): MailTarget[] {
    const out: MailTarget[] = []
    const covered = new Set<string>()
    for (const { openId, binding } of this.deps.binding.all()) {
      if (!binding.chatId || !binding.email) continue
      covered.add(binding.email.toLowerCase())
      out.push({
        email: binding.email,
        chatId: binding.chatId,
        ownerOpenId: openId,
        bot: binding.bot || this.deps.config.mail.bot,
      })
    }
    const mail = this.deps.config.mail
    if (mail.mailbox && mail.chatId && !covered.has(mail.mailbox.toLowerCase())) {
      out.push({ email: mail.mailbox, chatId: mail.chatId, ownerOpenId: mail.ownerOpenId, bot: mail.bot })
    }
    return out
  }

  start(): void {
    const mail = this.deps.config.mail
    if (!mail.enabled || this.timer || this.retryTimer) return
    this.loadSeen()
    const run = () => void this.tick()
    this.timer = setInterval(run, mail.intervalMinutes * 60_000)
    this.timer.unref?.()
    this.deps.logger.info("Mail watch started", { intervalMinutes: mail.intervalMinutes, targets: this.targets().length })
    run()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.timer = undefined
    this.retryTimer = undefined
  }

  /** First run for a mailbox: mark the current inbox as seen so history never floods the chat. */
  private async seed(target: MailTarget): Promise<void> {
    if (this.seeded.has(target.email)) return
    try {
      const ids = await this.listMessages(target.email, 20)
      const box = this.box(target.email)
      for (const id of ids) box.add(id)
      this.seeded.add(target.email)
      this.persistSeen()
      this.deps.audit.record("mailwatch.seeded", { count: ids.length, mailbox: target.email })
    } catch (error) {
      this.deps.logger.warn("Mail watch seed failed; will retry next tick", { error: message(error), mailbox: target.email })
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const target of this.targets()) {
        if (!this.seeded.has(target.email)) {
          await this.seed(target)
          continue
        }
        await this.tickOne(target)
      }
    } catch (error) {
      this.deps.logger.warn("Mail watch tick failed", { error: message(error) })
    } finally {
      this.ticking = false
    }
  }

  private async tickOne(target: MailTarget): Promise<void> {
    const ids = await this.listMessages(target.email, 10)
    const box = this.box(target.email)
    const fresh = ids.filter((id) => !box.has(id))
    const batch = fresh.reverse().slice(0, MAX_NEW_PER_TICK)
    for (const id of batch) {
      box.add(id)
      await this.triage(target, id).catch((error) => {
        this.deps.logger.warn("Mail triage failed", { id, error: message(error) })
      })
    }
    for (const id of fresh) box.add(id)
    if (batch.length > 0) this.persistSeen()
  }

  /** Silent agent verdict; a 「高」 line pushes the card to that user's chat. */
  private async triage(target: MailTarget, id: string): Promise<void> {
    const bot = this.deps.conversations.getBot(target.bot)
    if (!bot) return
    const detail = await this.getMessage(target.email, id)
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

    const reply = await this.deps.conversations.pregenerate(bot, target.chatId, prompt, undefined, target.ownerOpenId || undefined)
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
    const sent = await bot.sendCard(target.chatId, card)
    if (target.ownerOpenId && sent?.messageId) {
      await bot.urgentApp(sent.messageId, [target.ownerOpenId]).catch(() => {})
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
  private async listMessages(email: string, size: number): Promise<string[]> {
    const mailbox = encodeURIComponent(email)
    const data = await this.api(`/mail/v1/user_mailboxes/${mailbox}/messages?page_size=${size}&folder_id=INBOX`)
    return ((data.items as unknown[]) ?? [])
      .map((item) => (typeof item === "string" ? item : (item as MailMessage)?.message_id))
      .filter((id): id is string => Boolean(id))
  }

  private async getMessage(email: string, id: string): Promise<MailMessage> {
    const mailbox = encodeURIComponent(email)
    const data = await this.api(`/mail/v1/user_mailboxes/${mailbox}/messages/${encodeURIComponent(id)}`)
    // The detail payload lives under `message` (older code assumed `item`).
    return ((data.message as MailMessage | undefined) ?? (data.item as MailMessage | undefined) ?? data) as MailMessage
  }

  // ---- seen-id persistence ---------------------------------------------------

  private box(email: string): Set<string> {
    let box = this.seen.get(email)
    if (!box) {
      box = new Set()
      this.seen.set(email, box)
    }
    return box
  }

  private loadSeen(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.seenFile, "utf8")) as SeenFile
      const remember = (email: string, ids: string[] | undefined) => {
        if (!email) return
        const box = this.box(email)
        for (const id of ids ?? []) if (typeof id === "string" && id) box.add(id)
        if (box.size > 0) this.seeded.add(email)
      }
      if (data.mailbox) remember(data.mailbox, data.ids)
      for (const [email, ids] of Object.entries(data.boxes ?? {})) remember(email, ids)
    } catch {
      /* first run */
    }
  }

  private persistSeen(): void {
    const boxes: Record<string, string[]> = {}
    for (const [email, ids] of this.seen) boxes[email] = [...ids].slice(-MAX_SEEN)
    fs.writeFileSync(this.seenFile, JSON.stringify({ boxes }), "utf8")
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
