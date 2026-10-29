import fs from "node:fs"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import type { MarkdownStreamController, NormalizedMessage } from "@larksuiteoapi/node-sdk"
import type { AppConfig } from "../config/index.js"
import type { AuditLog, Logger } from "../util/logger.js"
import type { OpencodeService } from "../opencode/service.js"
import type { OpencodeEventBus } from "../opencode/events.js"
import type { OpencodeClient } from "../opencode/client.js"
import { BindingStore, type Binding } from "../storage/bindings.js"
import { mentionsFor, type FeishuBot, type SendOptions } from "../feishu/bot.js"
import { asksToChangeLocalConfig, CONFIG_CHANGE_DENIED } from "./configGuard.js"
import type { OpencodeEvent, PromptFileAttachment, SessionInfo } from "../opencode/types.js"
import type {
  ExecutionData,
  MessageInfo,
  ReasoningDeltaData,
  TextDeltaData,
  TextEndedData,
  ToolCalledData,
  ToolInputStartedData,
  ToolProgressData,
} from "../opencode/types.js"
import { AsyncQueue, KeyedSerial, createThrottle, sleep } from "../util/async.js"
import { ensureDir, ensureProjectLink, safeFileName, safeSegment } from "../util/paths.js"
import { isWorkbookFile } from "./office.js"
import { gapDoneCard, gapRetryCard, makeFormCard, markdownCard, nextFormNonce, welcomeCard, type MakeFormat, type MakeFormData, type MakeFormPreset } from "../feishu/cards.js"
import { ensureInstructions, extractFileMarkers } from "./instructions.js"
import {
  emitOfficeFile,
  emitRequestedOffice,
  fillMarkdown,
} from "./publish.js"
import { fitCardMarkdown, isProgressShell, TurnAccumulator, spinnerFrame, type TranscriptMessage } from "./turn.js"
import { CommandHandler } from "./commands.js"
import { writeMailScope, type MailBindingStore } from "../mail/binding.js"

export interface SessionContext {
  botName: string
  chatId: string
  replyTo?: string
  chatType?: "p2p" | "group"
  userOpenId?: string
}

interface TurnState {
  accumulator: TurnAccumulator
  toolNames: Map<string, string>
  sawEvent: boolean
  /** Idle strikes before the prompt is accepted are noise (session-create events). */
  promptAccepted: boolean
  /** When the prompt was accepted. No-text turns are not closed before this grace elapses. */
  acceptedAt?: number
  idleStrikes: number
  /** Last time the session showed progress (event received or observed busy). */
  lastActivity: number
  /** ID of the most recent assistant message seen in the event stream. */
  lastAssistantMessageID?: string
  signalRender: () => void
  settle: (error?: string) => void
  syncing: boolean
  /** Follow-ups already sent when the body finished but deliverable never started. */
  deliverableNudges?: number
  /** Assistant messages that already existed before this turn. */
  priorMessageIDs?: Set<string>
}

export interface ChatIdentity {
  chatId: string
  chatType: "p2p" | "group"
  senderId: string
  senderName?: string
}

export interface TurnRequest {
  bot: FeishuBot
  binding: Binding
  replyTo?: string
  text: string
  files?: PromptFileAttachment[]
  source: "user" | "command" | "cron"
  /** Silent cron pre-generation: run the agent fully but send nothing to the chat. */
  silent?: boolean
  /** Receives the rendered final text in silent mode. */
  onSilentResult?: (text: string) => void
  /** Receives the streaming card's message id once delivery completes (undefined on fallback). */
  onDelivered?: (messageId?: string) => void
  /** Card headline prefix (e.g. "⏰ 资讯订阅 · 晨报"). Ignored in silent mode. */
  cardTitle?: string
  /** Sender's openId, used to resolve personal templates. */
  userOpenId?: string
}

export interface ConversationDeps {
  config: AppConfig
  logger: Logger
  audit: AuditLog
  opencode: OpencodeService
  events: OpencodeEventBus
  bindings: BindingStore
  bots: Map<string, FeishuBot>
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 20_000
/** Let file messages from the same send land before a text-only instruction starts. */
const FILE_BURST_WAIT_MS = 1_200
// Inactivity window: a turn is only abandoned after this long with no
// progress at all. Legitimate long runs (e.g. a 16-sub-agent mission) keep the
// session `active`, which continuously renews the window.
const TURN_IDLE_TIMEOUT_MS = 60 * 60 * 1000
/** No assistant text and not busy for this long means the run never started. */
const EMPTY_TURN_GRACE_MS = 3 * 60_000
const OFFICE_OUTPUT_EXT = /\.(?:pptx|docx|xlsx|pdf)$/i

interface GapFillRecord {
  token: string
  botName: string
  chatId: string
  replyTo?: string
  directory: string
  source: string
  requestText: string
  fileNames: string[]
  templatePath?: string
  startedAt: number
}

/**
 * Placeholder forms the Lark SDK inserts for non-text resources:
 * `![image](imageKey)` for images and self-closing tags such as
 * `<file key="..." name="..."/>`, `<audio .../>`, `<video .../>`,
 * `<sticker .../>`, `<folder .../>`. They must be removed before deciding
 * whether a message carries an actual text instruction, otherwise a file-only
 * message looks like a text prompt and is sent to the agent immediately.
 */
const RESOURCE_PLACEHOLDER = /!\[[^\]]*\]\([^)]*\)|<(?:file|audio|video|media|sticker|folder)\b[^>]*\/?>/gi

/** Card markdown @ syntax. Kept on the card itself, because streaming updates replace the whole body. */
function cardMentionPrefix(chatType: string, openId?: string): string {
  if (chatType !== "group" || !openId) return ""
  return `<at id=${openId}></at>\n`
}

function stripResourcePlaceholders(input: string): string {
  return input.replace(RESOURCE_PLACEHOLDER, "").trim()
}

/** Exact pause phrases. A longer sentence that merely mentions 暂停 is a normal message. */
function isPause(text: string): boolean {
  const value = text.trim().toLowerCase()
  return value === "/stop" || value === "/pause" || value === "暂停" || value === "停止" || value === "停一下"
}

/** Menu buttons send their label as a user message. Map that label onto the real command. */
const CRON_LIST_WORDS = new Set(["定时任务", "查看定时任务", "我的订阅", "订阅列表", "查看订阅"])
/** 精确匹配这些词 → 弹出订阅表单卡片（点选式，零格式要求）。 */
const SUBSCRIBE_FORM_WORDS = new Set(["订阅", "资讯订阅", "订阅提醒", "新增订阅", "添加订阅"])
/** 精确匹配这些词 → 弹出订阅管理卡片（列表 + 暂停/编辑/删除）。 */
const SUBSCRIBE_MANAGE_WORDS = new Set(["取消订阅", "管理订阅", "订阅管理"])

function menuCommand(text: string): string {
  if (text === "新建对话") return "/new"
  if (text === "停止生成") return "/stop"
  if (text === "帮助") return "/help"
  if (text === "模板库") return "/templates"
  // 制作中心菜单（叶子节点发出的固定文本;「PPT 生成」与「生成 PPT」两种语序都认）。
  if (text === "文档制作" || text === "制作") return "/make doc"
  if (/^(?:PPT\s*(?:生成|制作)|生成\s*PPT)$/i.test(text)) return "/make ppt"
  if (/^(?:Word\s*(?:文档|生成|制作)|生成\s*Word|文档生成)$/i.test(text)) return "/make word"
  if (/^(?:PDF\s*(?:文档|生成|制作)|生成\s*PDF)$/i.test(text)) return "/make pdf"
  if (/^(?:Excel\s*(?:表格|生成|制作)?|生成\s*Excel|表格生成)$/i.test(text)) return "/make excel"
  if (text === "文案制作" || text === "制作文案") return "/make copy"
  if (text === "海报制作" || text === "制作海报") return "/make poster"
  if (text === "创作工作台") return "/studio copy"
  if (text === "生成海报" || text === "海报生成") return "/studio poster"
  if (text === "生成文案" || text === "文案创作") return "/studio copy"
  if (text === "电商套图") return "/studio commerce"
  if (text === "验证码登录" || text === "账号绑定") return "/login"
  if (text === "邮件订阅") return "/cron mail"
  // 邮箱绑定收归 bridge：contact API 校验「地址属于操作者本人」后才写配置，
  // 不放行给 agent 自由填写（否则输入别人的邮箱号也能绑）。
  if (text === "绑定邮箱" || text === "绑定我的邮箱" || text === "邮箱绑定") return "/mail bind"
  const mailBind = /^(?:我的飞书邮箱是|我的邮箱是|飞书邮箱是|邮箱是)\s*[:：]?\s*(\S+@\S+)$/.exec(text)
  if (mailBind) return `/mail bind ${mailBind[1]}`
  if (CRON_LIST_WORDS.has(text)) return "/cron manage"
  if (SUBSCRIBE_FORM_WORDS.has(text)) return "/cron form"
  if (SUBSCRIBE_MANAGE_WORDS.has(text)) return "/cron manage"
  const cancel = /^取消订阅\s*[:：]?\s*(.+)$/.exec(text) ?? /^删除订阅\s*[:：]?\s*(.+)$/.exec(text)
  if (cancel?.[1]) return `/cron remove ${cancel[1].trim()}`
  const subscribe = subscribeCommand(text)
  if (subscribe) return subscribe
  return text
}

/**
 * 固定文字模版订阅（非快捷键、非自由语义）：
 *   订阅 <频率> <时间> <内容>
 *   频率：每天 / 每工作日 / 每周一~日 / 每月N号；时间：24 小时制 9:00、18:30 或 9点30
 * 「订阅」开头才视为订阅意图；格式不符回固定用法提示，不放行给 agent（避免答非所问）。
 */
const SUBSCRIBE_DOW: Record<string, string> = { 一: "mon", 二: "tue", 三: "wed", 四: "thu", 五: "fri", 六: "sat", 日: "sun", 天: "sun" }
const SUBSCRIBE_INTENT_RE = /^订阅(?:\s|$|[:：,，])/
const SUBSCRIBE_RE =
  /^订阅[\s:：,，]+(每天|每工作日|每周\s*([一二三四五六日天])|每月\s*(\d{1,2})\s*号)[\s,，]+(\d{1,2})\s*(?:[:：]\s*(\d{1,2})|点\s*(?:(\d{1,2})\s*分?)?)[\s,，]+(.+)$/

function subscribeCommand(text: string): string | undefined {
  const t = text.trim()
  if (!SUBSCRIBE_INTENT_RE.test(t)) return undefined
  const m = SUBSCRIBE_RE.exec(t)
  if (!m) return "/cron add" // 订阅意图但格式不符 → 让 CronManager 回固定模版用法提示
  const prompt = (m[7] ?? "").trim()
  const hour = Number(m[4])
  const minute = Number(m[5] ?? m[6] ?? "0")
  if (hour > 23 || minute > 59 || prompt.length < 4) return "/cron add"
  let dom = "*"
  let dow = "*"
  if (m[1] === "每工作日") dow = "mon-fri"
  else if (m[2]) dow = SUBSCRIBE_DOW[m[2]] ?? "*"
  else if (m[3]) dom = String(Number(m[3]))
  const name = `订阅-${prompt.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "").slice(0, 8) || "资讯"}`
  return `/cron add ${name} ${minute} ${hour} ${dom} * ${dow} ${prompt}`
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("下载附件超时")), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Orchestrates the lifecycle of a conversation: binding a Feishu chat to an
 * OpenCode session, forwarding prompts, streaming the reply into a card, and
 * delivering files the agent produced.
 */
export class ConversationService {
  private readonly serial = new KeyedSerial()
  private readonly contexts = new Map<string, SessionContext>()
  /** Turns that are still running, so a pause can stop them without waiting in line. */
  private readonly activeTurns = new Map<string, { sessionID: string; settle: (error?: string) => void }>()
  private readonly commands: CommandHandler
  private mailBinding?: MailBindingStore
  private readonly linkedProjects = new Set<string>()
  private interactionProbe: (sessionID: string) => boolean = () => false
  private readonly gapInflight = new Set<string>()
  private recoveryTimer?: NodeJS.Timeout
  private followTimer?: NodeJS.Timeout
  private pregenSweepTimer?: NodeJS.Timeout
  private readonly recovering = new Set<string>()
  private readonly following = new Set<string>()
  private readonly followedBody = new Map<string, string>()

  constructor(private readonly deps: ConversationDeps) {
    this.commands = new CommandHandler(this)
  }

  /**
   * Register a probe that reports whether a session is currently blocked on an
   * interactive step (permission prompt or question form). While blocked, a turn
   * must stay open so the continuation after the user answers is still streamed.
   */
  setInteractionProbe(probe: (sessionID: string) => boolean): void {
    this.interactionProbe = probe
  }

  getContext(sessionID: string): SessionContext | undefined {
    return this.contexts.get(sessionID)
  }

  activeSessions(): string[] {
    return [...this.contexts.keys()]
  }

  get log(): Logger {
    return this.deps.logger
  }

  get audit(): AuditLog {
    return this.deps.audit
  }

  get config(): AppConfig {
    return this.deps.config
  }

  get bindings(): BindingStore {
    return this.deps.bindings
  }

  get opencode(): OpencodeService {
    return this.deps.opencode
  }

  get events(): OpencodeEventBus {
    return this.deps.events
  }

  getBot(name: string): FeishuBot | undefined {
    return this.deps.bots.get(name)
  }

  /** Expose the command router so the app can wire the cron/form handlers. */
  get commandHandler(): CommandHandler {
    return this.commands
  }

  setMailBinding(store: MailBindingStore): void {
    this.mailBinding = store
  }

  /** Drop this user's scope token into the session directory the mail tool reads. */
  plantMailScope(bot: FeishuBot, chatId: string, openId: string, chatType: "p2p" | "group"): void {
    const root = bot.config.location ?? this.deps.config.opencode.location
    const userId = bot.config.perUserInGroup && chatType === "group" ? openId : undefined
    this.writeMailScope(BindingStore.directory(root, bot.name, chatId, userId), openId)
  }

  private writeMailScope(directory: string, openId: string): void {
    const scope = this.mailBinding?.get(openId)?.scope
    if (!scope) return
    writeMailScope(directory, scope)
  }

  // ---- entry point --------------------------------------------------------

  async handleMessage(bot: FeishuBot, msg: NormalizedMessage): Promise<void> {
    const rawText = (msg.content ?? "").trim()
    // Drop the placeholders the Lark normalizer inserts for media resources
    // (images and file/audio/video/sticker tags); the actual files are
    // downloaded and attached separately. Without this a file-only message
    // looks like a text instruction and is sent to the agent right away.
    const text = menuCommand(stripResourcePlaceholders(rawText))
    if (!rawText && msg.resources.length === 0) return
    this.deps.audit.record("feishu.message", {
      bot: bot.name,
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderId: msg.senderId,
      text: rawText.slice(0, 500),
      resources: msg.resources.map((r) => r.type),
    })
    const identity: ChatIdentity = {
      chatId: msg.chatId,
      chatType: msg.chatType as "p2p" | "group",
      senderId: msg.senderId,
      senderName: msg.senderName,
    }
    // Process the message off the SDK's per-chat pipeline tail. The SDK
    // serializes card-action callbacks onto that same tail, and a turn that is
    // blocked on an interactive question would otherwise deadlock the callback
    // (Feishu then reports "目标回调服务超时未响应"). Returning here frees the
    // tail; we keep ordering ourselves via the keyed serial runner. In a group
    // with perUserInGroup, each sender has a separate key so people can run at once.
    // A text-only message waits briefly so file messages from the same send
    // can be stored first. Feishu often delivers the instruction before the files.
    if (isPause(text)) {
      await this.pauseTurn(bot, identity, msg.messageId)
      return
    }
    if (text.length > 0 && this.activeTurns.has(this.bindingKey(bot, identity))) {
      await bot
        .sendMarkdown(msg.chatId, "当前任务还在进行。点击下方菜单「停止生成」可停下来，停下来之后再发新内容。", {
          replyTo: msg.messageId,
          mentions: mentionsFor(msg.chatType, msg.senderId, msg.senderName),
        })
        .catch(() => {})
      return
    }
    const isolate = bot.config.perUserInGroup && msg.chatType === "group"
    const key = isolate ? `msg:${bot.name}:${msg.chatId}:${msg.senderId}` : `msg:${bot.name}:${msg.chatId}`
    const run = () => this.processMessage(bot, identity, msg, text)
    if (text.length > 0 && msg.resources.length === 0 && !text.startsWith("/")) {
      setTimeout(() => {
        void this.serial.run(key, run)
      }, FILE_BURST_WAIT_MS)
      return
    }
    void this.serial.run(key, run)
  }

  private async processMessage(
    bot: FeishuBot,
    identity: ChatIdentity,
    msg: NormalizedMessage,
    text: string,
  ): Promise<void> {
    try {
      if (bot.config.commands && text.startsWith("/")) {
        const handled = await this.commands.handle(bot, identity, msg, text)
        if (handled) return
      }
      // 「存为模板 [名字]」/「存为共享模板 [名字]」+ .pptx 附件：进模板注册表，不当任务处理。
      if (text.length > 0 && msg.resources.length > 0 && /(?:存|保存)(?:为)?\s*(?:共享\s*)?模板/.test(text)) {
        await this.saveTemplateRequest(bot, msg, text)
        return
      }
      // 寒暄/启动词（无任务内容）：直接展示能力卡片，不进 agent。
      if (text.length > 0 && msg.resources.length === 0 && isGreeting(text)) {
        const templates = this.listTemplates(msg.senderId)
        await bot.sendCard(msg.chatId, welcomeCard(templates.shared, templates.personal), {
          replyTo: msg.messageId,
          mentions: mentionsFor(msg.chatType, msg.senderId, msg.senderName),
        }).catch(() => {})
        this.deps.audit.record("greeting.shown", { bot: bot.name, chatId: msg.chatId })
        return
      }
      const binding = await this.ensureSession(bot, identity, msg.chatId)
      const held = binding.pendingAttachments ?? []

      // Files are stored first and are not parsed here. Parsing starts later,
      // only when an instruction is sent, inside the prompt.
      if (text.length > 0 && msg.resources.length > 0) {
        await bot
          .sendMarkdown(msg.chatId, "已收到。正在保存文件，保存完成后按你的指令开始解析。", {
            replyTo: msg.messageId,
            mentions: mentionsFor(msg.chatType, msg.senderId, msg.senderName),
          })
          .catch(() => {})
      }
      const incoming = msg.resources.length > 0 ? await this.prepareAttachments(bot, msg, binding) : []
      if (incoming.length > 0) await this.refreshPendingMakeForm(bot, msg.chatId, msg.senderId)
      if (msg.resources.length > 0 && incoming.length === 0) {
        await bot
          .sendMarkdown(msg.chatId, "这轮文件没有保存下来。请把文件重新发一次；文件和指令可以分两条消息发。", {
            replyTo: msg.messageId,
            mentions: mentionsFor(msg.chatType, msg.senderId, msg.senderName),
          })
          .catch(() => {})
        return
      }

      if (text.length > 0) {
        // A fresh instruction supersedes any open make-form: its buttons are dead now.
        this.revokeMakeForm(msg.chatId, msg.senderId)
        let promptText = text
        let files = [...held, ...incoming]
        // This message brought files, or earlier file-only messages are still
        // waiting. Only when neither exists do we resolve a reference against
        // the chat's saved copies.
        if (files.length === 0) {
          const cached = await this.referencedFiles(
            binding.chatId,
            path.join(binding.directory, "inbox"),
            text,
            binding.createdAt,
          )
          if (cached.length > 0) {
            files = cached
            promptText = `${text}\n\n本轮没有新文件。按你的指代，使用历史缓存里的材料。`
            this.deps.logger.info("Instruction refers to files already saved for this chat", {
              files: cached.map((file) => file.name),
            })
          } else if (expectsAttachedFiles(text)) {
            await bot
              .sendMarkdown(msg.chatId, "这一轮没有新文件，历史缓存里也没有对上的材料。请重新发送文件。", {
                replyTo: msg.messageId,
                mentions: mentionsFor(msg.chatType, msg.senderId, msg.senderName),
              })
              .catch(() => {})
            return
          }
        }
        const accepted = await this.runTurn({
          bot,
          binding,
          replyTo: msg.messageId,
          text: promptText,
          files,
          source: "user",
          userOpenId: msg.senderId,
        })
        if (accepted && held.length > 0) {
          binding.pendingAttachments = []
          this.deps.bindings.set(binding)
        }
        return
      }

      // Files sent without text: keep the saved copies and wait for the instruction.
      if (incoming.length > 0) {
        if (bot.config.holdAttachmentsWithoutText) {
          binding.pendingAttachments = [...held, ...incoming]
          this.deps.bindings.set(binding)
          this.deps.audit.record("attachment.held", {
            bot: bot.name,
            chatId: msg.chatId,
            sessionID: binding.sessionID,
            count: incoming.length,
            files: incoming.map((f) => f.name ?? f.uri),
          })
          await this.acknowledgeAttachments(bot, msg, incoming)
          return
        }
        const fallbackPrompt = msg.resources.some((r) => r.type === "image")
          ? "请看这张图片，并说明你的理解。"
          : "请查看我发送的附件。"
        await this.runTurn({
          bot,
          binding,
          replyTo: msg.messageId,
          text: fallbackPrompt,
          files: [...held, ...incoming],
          source: "user",
          userOpenId: msg.senderId,
        })
        return
      }
      // No text and no files: nothing to do.
    } catch (error) {
      await this.reportError(bot, msg.chatId, msg.messageId, error, mentionsFor(msg.chatType, msg.senderId, msg.senderName))
    }
  }

  /** Let the user know their files were received and are waiting for an instruction. */
  private async acknowledgeAttachments(
    bot: FeishuBot,
    msg: NormalizedMessage,
    files: PromptFileAttachment[],
  ): Promise<void> {
    const names = files.map((file) => file.name ?? "文件").join("、")
    const body = `已收到文件：${names}`
    await bot.sendMarkdown(msg.chatId, body, {
      replyTo: msg.messageId,
      mentions: mentionsFor(msg.chatType, msg.senderId, msg.senderName),
    }).catch((error) => {
      this.deps.logger.warn("Failed to acknowledge attachments", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** Run a scheduled prompt against a chat as if the user sent it. */
  async runScheduled(
    bot: FeishuBot,
    chatId: string,
    prompt: string,
    userId?: string,
    onDelivered?: (messageId?: string) => void,
    cardTitle?: string,
    userOpenId?: string,
  ): Promise<void> {
    const identity: ChatIdentity = {
      chatId,
      chatType: userId ? "group" : "p2p",
      senderId: userId ?? "cron",
      senderName: "cron",
    }
    const binding = await this.ensureSession(bot, identity, chatId)
    await this.runTurn({ bot, binding, text: prompt, source: "cron", onDelivered, cardTitle, userOpenId })
  }

  /**
   * Run a cron prompt silently (no cards, no messages) and return the rendered
   * reply, so the scheduler can pre-generate ahead of the delivery time.
   * Returns undefined when the turn produced no usable text.
   */
  async pregenerate(
    bot: FeishuBot,
    chatId: string,
    prompt: string,
    userId?: string,
    userOpenId?: string,
  ): Promise<string | undefined> {
    // Run on a throwaway session, never the chat's main session:
    // 1. the serial queue keys on binding.key, so a main-session pregen would
    //    block the user's own messages ("working" state);
    // 2. the recovery sweep only scans registered bindings — an unregistered
    //    throwaway session's reply can never be mistaken for a missed delivery
    //    and pushed early;
    // 3. the pre-generated text stays out of the main session's history.
    const identity: ChatIdentity = {
      chatId,
      chatType: userId ? "group" : "p2p",
      senderId: userId ?? "cron",
      senderName: "cron",
    }
    this.ensureBotProject(bot)
    const client = await this.deps.opencode.client()
    const root = bot.config.location ?? this.deps.config.opencode.location
    const scopedUser = bot.config.perUserInGroup && identity.chatType === "group" ? identity.senderId : undefined
    const directory = BindingStore.directory(root, bot.name, chatId, scopedUser)
    ensureDir(directory)
    ensureInstructions(directory)
    if (userOpenId) this.writeMailScope(directory, userOpenId)
    const session = await client.createSession({
      title: `定时预生成 ${new Date().toISOString()}`,
      agent: bot.config.agent,
      model: bot.config.model,
      directory,
      metadata: {
        source: "feishu-bridge",
        bot: bot.name,
        chatId,
        ephemeral: "cron-pregen",
      },
    })
    const binding: Binding = {
      key: `cron-pregen${bot.name}${chatId}${session.id}`,
      bot: bot.name,
      chatId,
      chatType: identity.chatType,
      userId: scopedUser,
      sessionID: session.id,
      directory,
      agent: bot.config.agent,
      model: bot.config.model,
      title: "定时预生成",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    let result: string | undefined
    try {
      await this.runTurn({
        bot,
        binding,
        text: prompt,
        source: "cron",
        silent: true,
        userOpenId,
        onSilentResult: (text) => {
          result = text.trim().length > 0 ? text : undefined
        },
      })
    } finally {
      // The throwaway session dies with the turn: even if something later
      // registered it, there is nothing left to recover and push early.
      try {
        await client.deleteSession(session.id)
      } catch {
        // session may already be gone
      }
      // runTurn 会把 binding 注册进持久 store，一次性预生成用完即删，
      // 既不膨胀 bindings.json，也让 recovery 再也扫不到它。
      this.deps.bindings.delete(binding.key)
    }
    return result
  }

  // ---- session binding ----------------------------------------------------

  bindingKey(bot: FeishuBot, identity: ChatIdentity): string {
    const isolate = bot.config.perUserInGroup && identity.chatType === "group"
    return BindingStore.key(bot.name, identity.chatId, isolate ? identity.senderId : undefined)
  }

  /**
   * Mirror the bot's OpenCode project into the bot's own folder
   * (`<location>/<bot>/`), so sessions stored under `location` still resolve
   * the project's agents/skills. Placed per bot (not at the shared location
   * root) so different bots can point at different projects. Idempotent.
   */
  private ensureBotProject(bot: FeishuBot): void {
    if (!bot.config.project) return
    const root = bot.config.location ?? this.deps.config.opencode.location
    const botDir = path.join(root, safeSegment(bot.name))
    const linkKey = `${botDir}\u0000${bot.config.project}`
    if (this.linkedProjects.has(linkKey)) return
    try {
      ensureProjectLink(botDir, bot.config.project)
      this.linkedProjects.add(linkKey)
    } catch (error) {
      this.deps.logger.warn("Failed to mirror OpenCode project into bot workspace", {
        botDir,
        project: bot.config.project,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async ensureSession(bot: FeishuBot, identity: ChatIdentity, _chatId: string): Promise<Binding> {
    const key = this.bindingKey(bot, identity)
    // Always ensure the project mirror, even for an existing binding, so the
    // workspace is self-healing (e.g. after the link was removed or on a new host).
    this.ensureBotProject(bot)
    const client = await this.deps.opencode.client()
    const existing = this.deps.bindings.get(key)
    if (existing) {
      try {
        const session = await client.getSession(existing.sessionID)
        if (session?.id) {
          if (identity.chatType === "group" && existing.agent !== bot.config.agent) {
            try {
              await client.switchAgent(existing.sessionID, bot.config.agent)
              existing.agent = bot.config.agent
              this.deps.bindings.set(existing)
            } catch (error) {
              this.deps.logger.warn("Failed to restore the group session agent", {
                key,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
          this.writeMailScope(existing.directory, identity.senderId)
          return existing
        }
      } catch {
        this.deps.logger.warn("Bound session no longer exists; creating a new one", {
          key,
          sessionID: existing.sessionID,
        })
        this.deps.bindings.delete(key)
      }
    }
    const root = bot.config.location ?? this.deps.config.opencode.location
    const userId = bot.config.perUserInGroup && identity.chatType === "group" ? identity.senderId : undefined
    const directory = BindingStore.directory(root, bot.name, identity.chatId, userId)
    ensureDir(directory)
    ensureInstructions(directory)
    const who = identity.senderName ?? identity.senderId
    const title =
      identity.chatType === "p2p" ? `飞书私聊 ${who}` : userId ? `飞书群聊 ${who}` : `飞书群聊 ${identity.chatId}`
    const session = await client.createSession({
      title,
      agent: bot.config.agent,
      model: bot.config.model,
      directory,
      metadata: {
        source: "feishu-bridge",
        bot: bot.name,
        chatId: identity.chatId,
        userId: identity.senderId,
      },
    })
    const binding: Binding = {
      key,
      bot: bot.name,
      chatId: identity.chatId,
      chatType: identity.chatType,
      userId,
      sessionID: session.id,
      directory,
      agent: bot.config.agent,
      model: bot.config.model,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.deps.bindings.set(binding)
    this.writeMailScope(directory, identity.senderId)
    this.deps.audit.record("session.created", {
      bot: bot.name,
      chatId: identity.chatId,
      userId,
      sessionID: session.id,
      directory,
    })
    return binding
  }

  async resetSession(bot: FeishuBot, identity: ChatIdentity): Promise<Binding> {
    const key = this.bindingKey(bot, identity)
    const existing = this.deps.bindings.get(key)
    if (existing) {
      clearInbox(existing.directory)
      this.deps.bindings.delete(key)
      try {
        const client = await this.deps.opencode.client()
        await client.deleteSession(existing.sessionID)
      } catch {
        // session may already be gone
      }
    }
    return this.ensureSession(bot, identity, identity.chatId)
  }

  // ---- attachments --------------------------------------------------------

  private async prepareAttachments(
    bot: FeishuBot,
    msg: NormalizedMessage,
    binding: Binding,
  ): Promise<PromptFileAttachment[]> {
    const files: PromptFileAttachment[] = []
    if (!msg.resources || msg.resources.length === 0) return files
    const inbox = path.join(binding.directory, "inbox")
    const cache = this.cacheDir(binding.chatId)
    ensureDir(inbox)
    for (const resource of msg.resources) {
      if (resource.type !== "image" && resource.type !== "file" && resource.type !== "audio" && resource.type !== "video") {
        this.deps.logger.info("Skipping unsupported incoming resource", { type: resource.type })
        continue
      }
      const name = resource.fileName ?? `${resource.type}_${safeSegment(resource.fileKey)}`
      try {
        let buffer: Buffer | undefined
        let lastError: unknown
        for (let attempt = 0; attempt < 2 && !buffer; attempt += 1) {
          try {
            const download = bot.downloadMessageResource(msg.messageId, resource.fileKey, resource.type, [
              msg.replyToMessageId ?? "",
              msg.rootId ?? "",
            ])
            buffer = await withTimeout(download, DOWNLOAD_TIMEOUT_MS)
          } catch (error) {
            lastError = error
            if (attempt === 0) await sleep(400)
          }
        }
        if (!buffer) throw lastError instanceof Error ? lastError : new Error("Failed to download attachment")
        if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
          this.deps.logger.warn("Attachment exceeds size limit", { fileKey: resource.fileKey, size: buffer.byteLength })
          continue
        }
        const savedName = resource.fileName ?? `${resource.type}_${safeSegment(resource.fileKey)}${guessExtension(buffer, resource.type)}`
        const local = path.join(inbox, `${Date.now()}_${safeFileName(savedName)}`)
        fs.writeFileSync(local, buffer)
        copyIntoCache(cache, local, savedName)
        files.push({ uri: pathToFileURL(local).href, name: savedName })
      } catch (error) {
        const savedName = resource.fileName
        const saved = savedName ? findSavedAttachment([inbox, cache], savedName) : undefined
        if (saved && savedName) {
          const local = placeInInbox(inbox, saved, savedName)
          this.deps.logger.info("Current message cannot download this file; using the saved copy", {
            fileName: resource.fileName,
            path: local,
          })
          files.push({ uri: pathToFileURL(local).href, name: savedName })
          continue
        }
        this.deps.logger.warn("Failed to download attachment", {
          fileKey: resource.fileKey,
          fileName: name,
          messageId: msg.messageId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return files
  }

  /** Durable copies live outside the agent workspace, which the agent may empty. */
  private cacheDir(chatId: string): string {
    return ensureDir(path.join(this.deps.config.storageDir, "file-cache", safeSegment(chatId)))
  }

  // ---- 制作中心（菜单向导） -------------------------------------------------

  /** Recent files the user sent in this chat, for the make-form's multi-select. */
  listCachedFilesFor(chatId: string, limit = 12): Array<{ label: string; value: string }> {
    return listCachedFiles(this.cacheDir(chatId))
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, limit)
      .map((file) => ({ label: file.name, value: path.basename(file.path) }))
  }

  /** Everything a make-form card needs: cached files + both template pools. */
  makeFormData(chatId: string, openId: string, format: MakeFormat): MakeFormData {
    const lists = this.listTemplates(openId)
    return {
      format,
      files: this.listCachedFilesFor(chatId),
      sharedTemplates: lists.shared,
      personalTemplates: lists.personal,
    }
  }

  /**
   * 制作表单卡的编号滑动窗口:同一会话只认最新一张卡,但该卡的每次重渲染
   * 都必须换新编号(SDK 对 12h 内相同 payload 的点击去重,不换会被吞)。
   * 校验接受窗口内所有编号——客户端尚未渲染出新卡面时,旧按钮的回调依然
   * 有效;只有开新卡、提交、取消、或发起其他任务才清空窗口。
   */
  private static readonly MAKE_NONCE_WINDOW = 10
  private activeMakeForms = new Map<string, number[]>()

  issueMakeForm(chatId: string, openId: string): number {
    const nonce = nextFormNonce()
    this.activeMakeForms.set(`${chatId}:${openId}`, [nonce])
    return nonce
  }

  /** Re-render of the same form: a fresh nonce joins the window; older renders stay valid. */
  rollMakeFormNonce(chatId: string, openId: string): number {
    const key = `${chatId}:${openId}`
    const nonce = nextFormNonce()
    const nonces = [...(this.activeMakeForms.get(key) ?? []), nonce]
    this.activeMakeForms.set(key, nonces.slice(-ConversationService.MAKE_NONCE_WINDOW))
    return nonce
  }

  makeFormActive(chatId: string, openId: string, nonce?: number): boolean {
    return nonce !== undefined && (this.activeMakeForms.get(`${chatId}:${openId}`)?.includes(nonce) ?? false)
  }

  revokeMakeForm(chatId: string, openId: string): void {
    this.activeMakeForms.delete(`${chatId}:${openId}`)
    this.pendingMakeUploads.delete(`${chatId}:${openId}`)
  }

  /**
   * 「添加本地文件」:按钮是表单提交,当前输入已随 form_value 带回并存为
   * preset;此后该会话新入缓存的文件(since 之后)一旦到达,就把表单卡原地
   * 重渲染——已填内容回填、新文件自动勾选。提交或超时后失效。
   */
  private pendingMakeUploads = new Map<
    string,
    { messageId: string; format: MakeFormat; preset: MakeFormPreset; since: number; expiresAt: number }
  >()

  beginMakeUpload(
    chatId: string,
    openId: string,
    messageId: string,
    format: MakeFormat,
    preset: MakeFormPreset,
  ): void {
    const now = Date.now()
    this.pendingMakeUploads.set(`${chatId}:${openId}`, {
      messageId,
      format,
      preset,
      since: now,
      expiresAt: now + 10 * 60_000,
    })
  }

  /** File arrived while a make-form was waiting: re-render it with the new file checked. */
  private async refreshPendingMakeForm(bot: FeishuBot, chatId: string, openId: string): Promise<void> {
    const pending = this.pendingMakeUploads.get(`${chatId}:${openId}`)
    if (!pending) return
    if (Date.now() > pending.expiresAt) {
      this.pendingMakeUploads.delete(`${chatId}:${openId}`)
      return
    }
    const data = this.makeFormData(chatId, openId, pending.format)
    const checked = new Set(pending.preset.files ?? [])
    for (const file of listCachedFiles(this.cacheDir(chatId))) {
      if (file.savedAt >= pending.since - 1000) checked.add(path.basename(file.path))
    }
    const valid = [...checked].filter((key) => data.files.some((file) => file.value === key))
    pending.preset = { ...pending.preset, files: valid }
    // 新渲染换编号进窗口(防 SDK 点击去重吞掉),旧卡面编号仍在窗口内有效。
    await bot
      .updateCard(pending.messageId, makeFormCard(data, pending.preset, this.rollMakeFormNonce(chatId, openId)), openId)
      .catch(() => {})
  }

  /**
   * Assemble and launch a make-form submission: picked cached files (+ an
   * optional Drive file link) become attachments; template and format words go
   * into the prompt so the normal turn pipeline resolves them as usual.
   */
  async submitMake(
    bot: FeishuBot,
    input: {
      chatId: string
      chatType: "p2p" | "group"
      senderId: string
      format: MakeFormat
      instruction: string
      fileKeys: string[]
      template: string
      cloud: string
    },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const identity: ChatIdentity = {
      chatId: input.chatId,
      chatType: input.chatType,
      senderId: input.senderId,
      senderName: "make",
    }
    const binding = await this.ensureSession(bot, identity, input.chatId)
    const cache = this.cacheDir(input.chatId)
    const files: PromptFileAttachment[] = []
    for (const key of input.fileKeys) {
      // Values are cache basenames ("<ts>_<name>"); reject anything path-like.
      if (!/^\d+_[^/\\]+$/.test(key)) continue
      const full = path.join(cache, key)
      if (!fs.existsSync(full)) continue
      files.push({ uri: pathToFileURL(full).href, name: key.replace(/^\d+_/, "") })
    }
    if (input.cloud) {
      const cloud = await this.downloadCloudIntoCache(bot, cache, input.cloud)
      if ("error" in cloud) return { ok: false, error: cloud.error }
      files.push({ uri: pathToFileURL(cloud.path).href, name: cloud.name })
    }
    const parts = [input.instruction]
    if (input.template) parts.push(`请使用「${input.template}」模板。`)
    const formatWord = { pptx: "PPT", docx: "Word 文档", pdf: "PDF", xlsx: "Excel 表格", copy: "" }[input.format]
    if (formatWord) parts.push(`请最终输出 ${formatWord} 文件。`)
    this.deps.audit.record("make.submitted", {
      bot: bot.name,
      chatId: input.chatId,
      format: input.format,
      files: files.length,
      template: input.template || undefined,
      cloud: input.cloud ? true : undefined,
      operator: input.senderId,
    })
    await this.runTurn({
      bot,
      binding,
      text: parts.join("\n"),
      files,
      source: "user",
      userOpenId: input.senderId,
    })
    return { ok: true }
  }

  /**
   * Fetch a Drive file link (云空间 /file/<token>) into the chat's cache so it
   * can ride along as an attachment. Online docs (文档/表格/多维表格) need an
   * export pipeline that does not exist yet — say so instead of failing oddly.
   */
  private async downloadCloudIntoCache(
    bot: FeishuBot,
    cache: string,
    url: string,
  ): Promise<{ path: string; name: string } | { error: string }> {
    const match = /\/(file|docx|docs|doc|sheets|sheet|bitable|base|wiki)\/([A-Za-z0-9]+)/.exec(url)
    if (!match?.[2]) {
      return { error: "云链接无法识别。请粘贴飞书云空间的文件链接(地址里含 /file/),或直接把文件发到聊天里。" }
    }
    const [, kind, token] = match
    if (kind !== "file") {
      return {
        error:
          "在线文档(文档/表格/多维表格/知识库)暂时不能直读:请在飞书里把它「下载/导出」成文件后发给我,或把导出的文件放进云空间再贴链接。",
      }
    }
    try {
      const buffer = await bot.downloadDriveFile(token)
      const ext = await sniffOfficeExtension(buffer)
      const name = `云文件_${token.slice(-8)}${ext}`
      const full = path.join(cache, `${Date.now()}_${name}`)
      fs.writeFileSync(full, buffer)
      return { path: full, name }
    } catch (error) {
      return {
        error: `云文件下载失败(${error instanceof Error ? error.message : String(error)})。可能是应用缺少云文档权限或文件未对应用开放;也可以直接把文件发到聊天里。`,
      }
    }
  }

  // ---- named templates ------------------------------------------------------

  /** Shared templates: readable by everyone, writable only by templateAdmins. */
  private sharedTemplatesDir(): string {
    return ensureDir(path.join(this.deps.config.storageDir, "templates", "shared"))
  }

  /** Personal templates: each user's own space, only visible to that user. */
  private personalTemplatesDir(openId: string): string {
    return ensureDir(path.join(this.deps.config.storageDir, "templates", "users", safeSegment(openId)))
  }

  private templateNames(dir: string): string[] {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }
    return names
      .filter((name) => name.toLowerCase().endsWith(".pptx"))
      .map((name) => path.basename(name, ".pptx"))
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
  }

  /** Template lists for cards: shared pool plus the caller's personal pool. */
  listTemplates(userOpenId?: string): { shared: string[]; personal: string[] } {
    return {
      shared: this.templateNames(this.sharedTemplatesDir()),
      personal: userOpenId ? this.templateNames(this.personalTemplatesDir(userOpenId)) : [],
    }
  }

  private resolveNamedTemplate(text: string, dir: string): string | undefined {
    const hits = this.templateNames(dir)
      .map((stem) => ({ stem, full: path.join(dir, `${stem}.pptx`) }))
      .filter((entry) => entry.stem.length > 0 && text.includes(entry.stem))
      .sort((a, b) => b.stem.length - a.stem.length)
    return hits[0]?.full
  }

  /**
   * The deck template for one request: an attached .pptx wins; otherwise the
   * caller's personal template named in the text; otherwise a shared one.
   */
  private resolveTemplate(text: string, files: PromptFileAttachment[] | undefined, userOpenId?: string): string | undefined {
    const attached = templatePathFrom(files)
    if (attached) return attached
    if (userOpenId) {
      const personal = this.resolveNamedTemplate(text, this.personalTemplatesDir(userOpenId))
      if (personal) return personal
    }
    return this.resolveNamedTemplate(text, this.sharedTemplatesDir())
  }

  /**
   * Save an attached .pptx as a named template. 「存为模板 X」goes to the
   * sender's personal pool; 「存为共享模板 X」goes to the shared pool and is
   * restricted to templateAdmins — others get a personal copy instead.
   */
  private async saveTemplateRequest(bot: FeishuBot, msg: NormalizedMessage, text: string): Promise<void> {
    const resource =
      msg.resources.find((r) => r.type === "file" && (r.fileName ?? "").toLowerCase().endsWith(".pptx")) ??
      msg.resources.find((r) => r.type === "file")
    if (!resource) {
      await bot
        .sendMarkdown(msg.chatId, "存模板需要一个 .pptx 文件，请把模板文件和这句话一起发。", {
          replyTo: msg.messageId,
          mentions: mentionsFor(msg.chatType, msg.senderId, msg.senderName),
        })
        .catch(() => {})
      return
    }
    const wantsShared = /(?:存|保存)(?:为)?\s*共享\s*模板/.test(text)
    const named = /模板\s*[「"']?\s*([^\s」"',，。.]+)/.exec(text)?.[1]
    const fallback = path.basename(resource.fileName ?? "模板").replace(/\.pptx$/i, "")
    const stem = (named || fallback).replace(/[\\/:*?"<>|]/g, "").trim() || "模板"
    const isAdmin = this.deps.config.templateAdmins.includes(msg.senderId)
    const shared = wantsShared && isAdmin
    try {
      const buffer = await bot.downloadMessageResource(msg.messageId, resource.fileKey, "file")
      const dir = shared ? this.sharedTemplatesDir() : this.personalTemplatesDir(msg.senderId)
      fs.writeFileSync(path.join(dir, `${stem}.pptx`), buffer)
      this.deps.audit.record("template.saved", {
        bot: bot.name,
        chatId: msg.chatId,
        name: stem,
        scope: shared ? "shared" : "personal",
        bytes: buffer.length,
      })
      const lists = this.listTemplates(msg.senderId)
      const format = (names: string[]) =>
        names.length ? names.map((name) => (name === stem ? `**${name}**` : name)).join("、") : "暂无"
      const headline = shared
        ? `共享模板 **${stem}** 已保存，全员可用。`
        : wantsShared
          ? `共享模板仅管理员可维护，已为你存为个人模板 **${stem}**。`
          : `个人模板 **${stem}** 已保存。`
      await bot
        .sendMarkdown(
          msg.chatId,
          `${headline}以后说「用${stem}模板」即可直接套用，不用再发文件。\n共享模板：${format(lists.shared)}\n我的模板：${format(lists.personal)}`,
          {
            replyTo: msg.messageId,
            mentions: mentionsFor(msg.chatType, msg.senderId, msg.senderName),
          },
        )
        .catch(() => {})
    } catch (error) {
      this.deps.logger.warn("Failed to save template", {
        error: error instanceof Error ? error.message : String(error),
      })
      await bot
        .sendMarkdown(msg.chatId, "模板没有保存成功，请重发一次文件。", {
          replyTo: msg.messageId,
          mentions: mentionsFor(msg.chatType, msg.senderId, msg.senderName),
        })
        .catch(() => {})
    }
  }

  /**
   * Files this message did not attach. Only copies saved in the current task
   * count, and only when the user actually refers to them.
   */
  private async referencedFiles(chatId: string, inbox: string, text: string, since: number): Promise<PromptFileAttachment[]> {
    const cached = listCachedFiles(this.cacheDir(chatId)).filter((file) => file.savedAt >= since)
    let matched = matchCachedFiles(text, cached)
    if (matched.length === 0 && asksForSpreadsheets(text)) {
      const books: CachedFile[] = []
      for (const file of cached) {
        if (await isWorkbookFile(file.path)) books.push(file)
      }
      matched = latestOf(books)
    }
    return matched.map((file) => {
      const local = placeInInbox(inbox, file.path, file.name)
      return { uri: pathToFileURL(local).href, name: file.name }
    })
  }

  // ---- the turn -----------------------------------------------------------

  async runTurn(request: TurnRequest): Promise<boolean> {
    const { bot, binding } = request
    if (binding.chatType === "group" && request.source !== "cron" && asksToChangeLocalConfig(request.text)) {
      this.deps.audit.record("config.change.denied", {
        bot: bot.name,
        chatId: binding.chatId,
        userId: request.userOpenId ?? binding.userId,
      })
      if (!request.silent) {
        await bot
          .sendMarkdown(binding.chatId, CONFIG_CHANGE_DENIED, {
            replyTo: request.replyTo,
            mentions: mentionsFor("group", request.userOpenId ?? binding.userId),
          })
          .catch(() => {})
      }
      return false
    }
    return this.serial.run(binding.key, async () => {
      const startedAt = Date.now()
      const client = await this.deps.opencode.client()
      const accumulator = new TurnAccumulator(bot.config.streaming.showTools, bot.config.streaming.showReasoning)
      if (!request.silent && request.cardTitle) accumulator.titlePrefix = request.cardTitle
      const renderQueue = new AsyncQueue<void>()
      const throttle = createThrottle(bot.config.streaming.intervalMs)
      const signalRender = () => throttle(() => renderQueue.push())

      let closed = false
      let failure: string | undefined
      let settled = false
      let resolveCompletion: () => void = () => {}
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve
      })
      let paused = false
      const settle = (error?: string) => {
        if (settled) return
        settled = true
        if (error === "已暂停") paused = true
        failure = error ?? failure
        resolveCompletion()
      }
      this.activeTurns.set(binding.key, { sessionID: binding.sessionID, settle })
      try {

      const state: TurnState = {
        accumulator,
        toolNames: new Map(),
        sawEvent: false,
        promptAccepted: false,
        idleStrikes: 0,
        lastActivity: Date.now(),
        signalRender,
        settle,
        syncing: false,
      }

      let streamMessageId: string | undefined
      let lastCardBody = ""
      const producer = async (controller: MarkdownStreamController): Promise<void> => {
        const live = controller as MarkdownStreamController & { cardId?: string }
        if (live.messageId) streamMessageId = live.messageId
        this.rememberProgress(binding, live.messageId, live.cardId)
        const paint = async (force: boolean) => {
          const raw = styleRouteFooter(extractFileMarkers(accumulator.render(closed ? "done" : "live")).text)
          const waiting = raw.length > 0 ? raw : `${spinnerFrame()} 收到，正在生成`
          const withError =
            closed && failure ? (failure === "已暂停" ? `${waiting}\n\n已暂停` : `${waiting}\n\n> ⚠️ ${failure}`) : waiting
          const mention = request.source === "user" ? cardMentionPrefix(binding.chatType, request.userOpenId) : ""
          const body = mention + fitCardMarkdown(withError)
          if (!force && body === lastCardBody) return
          lastCardBody = body
          try {
            await controller.setContent(body)
          } catch (error) {
            this.deps.logger.warn("Failed to fill streaming card", {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        await paint(true)
        for await (const _ of renderQueue) {
          await paint(closed)
          if (closed) break
        }
      }

      const context: SessionContext = {
        botName: bot.name,
        chatId: binding.chatId,
        replyTo: request.replyTo,
        chatType: binding.chatType,
        userOpenId: request.userOpenId ?? binding.userId,
      }
      this.contexts.set(binding.sessionID, context)

      const streamPromise = request.silent
        ? Promise.resolve(undefined)
        : bot
            .stream(binding.chatId, { markdown: producer }, { replyTo: request.replyTo })
            .catch((error) => {
              this.deps.logger.error("Failed to open streaming card", {
                error: error instanceof Error ? error.message : String(error),
                detail: errorDetail(error),
              })
              return undefined
            })

      const unsubscribe = this.deps.events.subscribe((event) => {
        this.onEvent(event, binding.sessionID, state)
      })

      const watchdog = setInterval(() => {
        void this.checkIdle(client, binding.sessionID, state)
      }, 3_000)
      const syncTimer = setInterval(() => {
        if (closed) return
        void this.syncTranscript(client, binding.sessionID, state)
      }, 1_000)
      const spinTimer = setInterval(() => {
        if (closed) return
        signalRender()
      }, bot.config.streaming.intervalMs)

      let accepted = false
      const promptFiles = request.files ?? []
      accumulator.setFileNames((request.files ?? []).map((file) => file.name ?? "").filter((name) => name.length > 0))
      state.priorMessageIDs = await this.priorAssistantIDs(client, binding.sessionID)
      try {
        await client.prompt(binding.sessionID, {
          text: request.text,
          files: promptFiles,
        })
        accepted = true
        // The watchdog has been ticking since before this call. Session-create
        // events set sawEvent, and four "not busy" observations would otherwise
        // close the turn the moment the prompt returns — before the agent writes
        // anything. Start the idle clock only now.
        state.promptAccepted = true
        state.acceptedAt = Date.now()
        state.idleStrikes = 0
        state.lastActivity = state.acceptedAt
        binding.updatedAt = Date.now()
        this.deps.bindings.set(binding)
        this.deps.audit.record("prompt.sent", {
          bot: bot.name,
          chatId: binding.chatId,
          sessionID: binding.sessionID,
          source: request.source,
          text: request.text.slice(0, 500),
          attachments: promptFiles.length,
        })
        await completion
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
        settle(failure)
      } finally {
        clearInterval(watchdog)
        clearInterval(syncTimer)
        clearInterval(spinTimer)
        unsubscribe()
      }

      // Reconcile with the server transcript in case we missed events.
      await this.reconcile(client, binding.sessionID, accumulator, state.priorMessageIDs)
      closed = true
      signalRender()
      renderQueue.push()
      renderQueue.close()
      await streamPromise

      const visible = accumulator.text

      // Silent pre-generation: deliver nothing to the chat, hand the rendered
      // text back to the caller, and release the session like a normal turn.
      if (request.silent) {
        // Pregen is delivered as the answer itself. The progress chrome
        // ("处理完成 / 解读指令") is for the live card; caching it when the
        // agent wrote nothing is how an empty shell got pushed at 09:00.
        const answer = styleRouteFooter(extractFileMarkers(accumulator.text).text).trim()
        request.onSilentResult?.(failure || isProgressShell(answer) ? "" : answer)
        this.deps.audit.record("turn.pregen", {
          bot: bot.name,
          chatId: binding.chatId,
          sessionID: binding.sessionID,
          durationMs: Date.now() - startedAt,
          route: routeFrom(visible),
          failure,
          text: request.text.slice(0, 120),
        })
        this.clearProgress(binding)
        this.contexts.delete(binding.sessionID)
        return accepted
      }

      let delivered = Boolean(streamMessageId) && accumulator.hasContent

      // If the streaming card never opened, still deliver the reply as a
      // plain message so the user always gets an answer.
      if (!request.silent && !streamMessageId && accumulator.hasContent) {
        const rendered = styleRouteFooter(extractFileMarkers(accumulator.render()).text)
        const fallback =
          failure === "已暂停" ? `${rendered}\n\n已暂停` : failure ? `${rendered}\n\n> ⚠️ ${failure}` : rendered
        try {
          await bot.sendCardResilient(binding.chatId, markdownCard(accumulator.headline(), fallback), {
            replyTo: request.replyTo,
            mentions: request.source === "user" ? mentionsFor(binding.chatType, request.userOpenId) : undefined,
          })
          delivered = true
        } catch (error) {
          this.deps.logger.error("Failed to send fallback reply", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const { files } = paused ? { files: [] as { kind: "file" | "image"; path: string }[] } : extractFileMarkers(visible)
      // A finished office file makes the markdown beside it an intermediate
      // draft: never upload it, and register it as handled so the recovery
      // sweep does not push it later either.
      const suppressMarkdown = !paused && this.hasFreshOfficeOutput(binding.directory, startedAt)
      const suppressed: string[] = []
      const outgoing = files.filter((file) => {
        if (suppressMarkdown && file.path.toLowerCase().endsWith(".md")) {
          suppressed.push(path.resolve(file.path))
          return false
        }
        return true
      })
      const sent = await this.deliverFiles(bot, binding.chatId, outgoing, request.replyTo)
      for (const item of suppressed) sent.add(item)
      if (!paused) {
        try {
          const office = await emitRequestedOffice({
            directory: binding.directory,
            requestText: request.text,
            fileNames: (request.files ?? []).map((file) => file.name ?? file.uri),
            templatePath: this.resolveTemplate(request.text, request.files, request.userOpenId),
            startedAt,
          })
          for (const source of office.sources) sent.add(path.resolve(source))
        } catch (error) {
          this.deps.logger.warn("Failed to build office file", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        await this.deliverFreshOutputs(bot, binding.directory, binding.chatId, startedAt, sent, request.replyTo)
      }
      this.rememberSent(binding, sent)

      // One telemetry record per turn: the basis for spotting slow task types,
      // routing misses and delivery gaps in audit.jsonl.
      this.deps.audit.record("turn.completed", {
        bot: bot.name,
        chatId: binding.chatId,
        sessionID: binding.sessionID,
        source: request.source,
        durationMs: Date.now() - startedAt,
        route: routeFrom(visible),
        sent: [...sent].map((file) => path.basename(file)),
        paused,
        failure,
        text: request.text.slice(0, 120),
      })

      // Record what we delivered so the recovery sweep will not push it again.
      // Anything the session produces afterwards (e.g. a final answer that
      // landed after a timeout) carries a new message ID and is still caught.
      if (delivered) {
        const mark = state.lastAssistantMessageID ?? (await this.latestAssistantMessageID(client, binding.sessionID))
        if (mark && mark !== binding.lastDeliveredMessageID) {
          binding.lastDeliveredMessageID = mark
          binding.updatedAt = Date.now()
          this.deps.bindings.set(binding)
        }
      }

      // Release the session last: while the context is registered the recovery
      // sweep leaves it alone, which prevents a duplicate delivery in the gap
      // between rendering and recording the watermark.
      request.onDelivered?.(streamMessageId)
      this.clearProgress(binding)
      this.contexts.delete(binding.sessionID)
      return accepted
      } finally {
        this.activeTurns.delete(binding.key)
      }
    })
  }

  /** Stop the running turn immediately. This does not wait behind that turn. */
  private async pauseTurn(bot: FeishuBot, identity: ChatIdentity, replyTo?: string): Promise<void> {
    const active = this.activeTurns.get(this.bindingKey(bot, identity))
    if (!active) {
      await bot.sendMarkdown(identity.chatId, "当前没有正在进行的任务。", {
        replyTo,
        mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName),
      }).catch(() => {})
      return
    }
    try {
      const client = await this.deps.opencode.client()
      await client.interrupt(active.sessionID)
    } catch (error) {
      this.deps.logger.warn("Failed to interrupt the running session", {
        sessionID: active.sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    active.settle("已暂停")
    await bot.sendMarkdown(identity.chatId, "已暂停", {
      replyTo,
      mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName),
    }).catch(() => {})
  }

  /** Remember the streaming card so a restart can finish it instead of leaving the spinner. */
  private rememberProgress(binding: Binding, messageID?: string, cardID?: string): void {
    const message = messageID?.trim() || undefined
    const card = cardID?.trim() || undefined
    let changed = false
    if (message && binding.progressMessageID !== message) {
      binding.progressMessageID = message
      changed = true
    }
    if (card && binding.progressCardID !== card) {
      binding.progressCardID = card
      changed = true
    }
    if (!changed) return
    binding.updatedAt = Date.now()
    this.deps.bindings.set(binding)
    this.deps.bindings.flush()
  }

  private clearProgress(binding: Binding): void {
    if (!binding.progressMessageID && !binding.progressCardID) return
    binding.progressMessageID = undefined
    binding.progressCardID = undefined
    binding.updatedAt = Date.now()
    this.deps.bindings.set(binding)
    this.deps.bindings.flush()
  }

  private onEvent(event: OpencodeEvent, sessionID: string, state: TurnState): void {
    const data = event.data as Record<string, unknown> | undefined
    if (!data) return
    const eventSession = typeof data.sessionID === "string" ? data.sessionID : ""
    const parentSession = typeof data.parentID === "string" ? data.parentID : ""
    const isMainSession = eventSession === sessionID
    const isChildSession = !isMainSession && parentSession === sessionID
    if (!isMainSession && !isChildSession) return
    const { accumulator, toolNames, signalRender, settle } = state
    state.sawEvent = true
    state.lastActivity = Date.now()
    const messageID = (data as { assistantMessageID?: string }).assistantMessageID
    if (messageID) state.lastAssistantMessageID = messageID
    switch (event.type) {
      case "session.text.delta": {
        // 流式展示规范：子 Agent（子会话）的过程文本不进卡片，
        // 避免内部自语与工具调用 JSON 透出；只有主 Agent 的文本用户可见。
        if (!isMainSession) break
        const d = data as unknown as TextDeltaData
        accumulator.addText(d.assistantMessageID, d.ordinal, d.delta)
        signalRender()
        break
      }
      case "session.text.ended": {
        if (!isMainSession) break
        const d = data as unknown as TextEndedData
        accumulator.setText(d.assistantMessageID, d.ordinal, d.text)
        signalRender()
        break
      }
      case "session.reasoning.delta": {
        if (!isMainSession) break
        const d = data as unknown as ReasoningDeltaData
        accumulator.addReasoning(d.delta)
        signalRender()
        break
      }
      case "session.tool.input.started": {
        const d = data as unknown as ToolInputStartedData
        toolNames.set(d.id, d.name)
        break
      }
      case "session.tool.called": {
        const d = data as unknown as ToolCalledData
        const raw = toolNames.get(d.id) ?? "tool"
        const label = labelForTool(raw, d.input)
        toolNames.set(d.id, label)
        if (!isAgentLabel(label)) break
        accumulator.setTool(d.id, label, "running")
        signalRender()
        break
      }
      case "session.tool.progress": {
        const d = data as unknown as ToolProgressData
        const call = d.metadata?.toolCalls?.[0]
        if (call) {
          const current = toolNames.get(d.id)
          const label = isAgentLabel(current) ? current : labelForTool(call.tool, call.input)
          toolNames.set(d.id, label)
          if (!isAgentLabel(label)) break
          accumulator.setTool(d.id, label, call.status === "completed" ? "completed" : "running")
          signalRender()
        }
        break
      }
      case "session.tool.success":
      case "session.tool.error": {
        const d = data as unknown as ToolCalledData
        const label = toolNames.get(d.id) ?? ""
        if (!isAgentLabel(label)) break
        accumulator.setTool(d.id, label, event.type.endsWith("error") ? "error" : "completed")
        signalRender()
        break
      }
      case "session.execution.succeeded": {
        signalRender()
        // One user turn is several assistant messages (A13/A54, then A43, then
        // A61). This event fires at the end of each message. Closing here left
        // the card on the first agents while the rest were still running.
        break
      }
      case "session.execution.failed": {
        const d = data as unknown as ExecutionData
        settle(d.error?.message ?? "执行失败")
        break
      }
      default:
        break
    }
  }

  private async checkIdle(client: OpencodeClient, sessionID: string, state: TurnState): Promise<void> {
    const now = Date.now()
    await this.syncTranscript(client, sessionID, state)
    if (state.accumulator.hasRunning) {
      state.idleStrikes = 0
      state.lastActivity = now
      return
    }
    const continuation = state.accumulator.continuationPrompt()
    if (continuation && (state.deliverableNudges ?? 0) < 2 && now - state.lastActivity > 20_000) {
      state.deliverableNudges = (state.deliverableNudges ?? 0) + 1
      state.lastActivity = now
      state.idleStrikes = 0
      void client.prompt(sessionID, { text: continuation }).catch((error) => {
        this.deps.logger.warn("Failed to continue a stalled step", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return
    }
    // Give up only after a full window with no progress whatsoever. A session
    // that is still running renews this above, so long multi-agent missions are
    // never cut off mid-flight.
    if (now - state.lastActivity > TURN_IDLE_TIMEOUT_MS) {
      this.deps.logger.warn("Turn abandoned after inactivity", {
        sessionID,
        idleMs: now - state.lastActivity,
      })
      state.settle("执行超时，已停止等待回复。")
      return
    }
    if (!state.promptAccepted || !state.sawEvent) return
    // Never treat a session blocked on a form/permission as finished.
    if (this.interactionProbe(sessionID)) {
      state.idleStrikes = 0
      return
    }
    try {
      const active = await client.listActiveSessions()
      const busy = active && Object.prototype.hasOwnProperty.call(active, sessionID)
      if (busy) {
        const quietMs = now - state.lastActivity
        const nudgePending = Boolean(continuation) && (state.deliverableNudges ?? 0) < 2
        if (state.accumulator.hasRunning || nudgePending || quietMs < 90_000) {
          state.idleStrikes = 0
          if (state.accumulator.hasRunning) state.lastActivity = now
          return
        }
      }
      // No assistant text yet: "not in the active list" is the startup gap
      // (the 09:00 empty card), not a finished turn. Keep waiting. Only a
      // sustained silence with zero text is a failure, and that must not be
      // cached as a successful pre-generation.
      if (!state.accumulator.hasContent) {
        const sinceAccept = state.acceptedAt ? now - state.acceptedAt : 0
        if (sinceAccept > EMPTY_TURN_GRACE_MS) state.settle("模型没有返回正文，已停止等待。")
        return
      }
      // Several idle observations: A54 finishing and A43 starting can leave a
      // short gap where nothing looks busy yet.
      state.idleStrikes += 1
      if (state.idleStrikes >= 4) state.settle()
    } catch {
      // transient; the event stream or inactivity window will settle the turn
    }
  }

  private async reconcile(client: OpencodeClient, sessionID: string, accumulator: TurnAccumulator, priorMessageIDs?: Set<string>): Promise<void> {
    try {
      const messages = await client.messages(sessionID)
      accumulator.absorb(transcriptFrom(messages, priorMessageIDs))
    } catch {
      // ignore; an empty reply is acceptable
    }
  }

  /** Assistant replies already in the session, so this turn's card does not repeat them. */
  private async priorAssistantIDs(client: OpencodeClient, sessionID: string): Promise<Set<string> | undefined> {
    try {
      const messages = await client.messages(sessionID)
      return new Set(messages.filter((message) => message.type === "assistant" && message.id).map((message) => message.id))
    } catch {
      return undefined
    }
  }

  /** Pull the server transcript while a tool still looks busy, so a finished sub-agent does not spin forever. */
  private async syncTranscript(client: OpencodeClient, sessionID: string, state: TurnState): Promise<void> {
    if (state.syncing) return
    state.syncing = true
    try {
      const messages = await client.messages(sessionID)
      if (state.accumulator.absorb(transcriptFrom(messages, state.priorMessageIDs))) state.signalRender()
    } catch {
      // the event stream or the final reconcile still updates the card
    } finally {
      state.syncing = false
    }
  }

  /**
   * Finish a gap-fill card that was sent before this path was removed.
   * New turns no longer create these cards; missing text is supplied in chat.
   */
  async completeGapFill(
    bot: FeishuBot,
    token: string,
    answers: Record<string, string>,
    messageId: string,
  ): Promise<void> {
    if (!/^[a-f0-9]{16}$/.test(token) || this.gapInflight.has(token)) return
    const recordPath = path.join(this.gapDir(), `${token}.json`)
    if (!fs.existsSync(recordPath)) {
      await bot.updateCard(messageId, gapDoneCard("这份补充已经处理过了。", "grey")).catch(() => {})
      return
    }
    this.gapInflight.add(token)
    try {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as GapFillRecord
      if (record.botName !== bot.name || record.token !== token) return
      const markdown = fs.readFileSync(record.source, "utf8")
      fs.writeFileSync(record.source, fillMarkdown(markdown, answers), "utf8")
      const office = await emitOfficeFile({
        source: record.source,
        requestText: record.requestText,
        fileNames: record.fileNames,
        templatePath: record.templatePath,
      })
      let sentCount = 0
      for (const output of office.outputs) {
        if (await this.sendOutputFile(bot, record.chatId, output, "file", record.replyTo)) sentCount += 1
      }
      if (office.outputs.length > 0 && sentCount === 0) throw new Error("文件没有发到聊天窗口")
      fs.rmSync(recordPath, { force: true })
      const filled = Object.values(answers).filter((value) => value.trim().length > 0).length
      const note =
        office.outputs.length > 0
          ? `已写入 ${filled} 处补充，文件已发到聊天窗口。留空的部分仍是「未提供」。`
          : "补充已写入，这次没有需要生成的办公文件。"
      await bot.updateCard(messageId, gapDoneCard(note)).catch(() => {})
      this.deps.audit.record("gap.completed", { token, outputs: sentCount, filled })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.logger.warn("Failed to continue after gap fill", { token, error: reason })
      await bot.updateCard(messageId, gapRetryCard(reason, token)).catch(() => {})
    } finally {
      this.gapInflight.delete(token)
    }
  }

  private gapDir(): string {
    return ensureDir(path.join(this.deps.config.storageDir, "gap-fills"))
  }

  private async deliverFiles(
    bot: FeishuBot,
    chatId: string,
    files: { kind: "file" | "image"; path: string }[],
    replyTo?: string,
  ): Promise<Set<string>> {
    const sent = new Set<string>()
    for (const file of files) {
      const delivered = await this.sendOutputFile(bot, chatId, file.path, file.kind, replyTo)
      if (delivered) sent.add(path.resolve(file.path))
    }
    return sent
  }

  /** Send files written under deliverables/ during this turn, even without a marker. */
  private async deliverFreshOutputs(
    bot: FeishuBot,
    directory: string,
    chatId: string,
    startedAt: number,
    alreadySent: Set<string>,
    replyTo?: string,
  ): Promise<void> {
    const dir = path.join(directory, "deliverables")
    if (!fs.existsSync(dir)) return
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    const freshOffice = names.some((name) => {
      if (!OFFICE_OUTPUT_EXT.test(name)) return false
      try {
        return fs.statSync(path.join(dir, name)).mtimeMs + 1000 >= startedAt
      } catch {
        return false
      }
    })
    for (const name of names) {
      const full = path.join(dir, name)
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.mtimeMs + 1000 < startedAt) continue
      // The markdown draft ships only when no office file came out this turn.
      if (freshOffice && name.toLowerCase().endsWith(".md")) continue
      const resolved = path.resolve(full)
      if (alreadySent.has(resolved)) continue
      if (await this.sendOutputFile(bot, chatId, full, "file", replyTo)) alreadySent.add(resolved)
    }
  }

  /** True when this turn produced a finished office file under deliverables/. */
  private hasFreshOfficeOutput(directory: string, startedAt: number): boolean {
    const dir = path.join(directory, "deliverables")
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return false
    }
    return names.some((name) => {
      if (!OFFICE_OUTPUT_EXT.test(name)) return false
      try {
        return fs.statSync(path.join(dir, name)).mtimeMs + 1000 >= startedAt
      } catch {
        return false
      }
    })
  }

  private async sendOutputFile(
    bot: FeishuBot,
    chatId: string,
    filePath: string,
    kind: "file" | "image",
    replyTo?: string,
  ): Promise<boolean> {
    try {
      if (!fs.existsSync(filePath)) {
        this.deps.logger.warn("Agent referenced a missing file", { path: filePath })
        return false
      }
      if (kind === "image") {
        await bot.sendImage(chatId, filePath, { replyTo })
      } else {
        await bot.sendFile(chatId, filePath, path.basename(filePath), { replyTo })
      }
      this.deps.audit.record("file.sent", { chatId, path: filePath, kind })
      return true
    } catch (error) {
      this.deps.logger.warn("Failed to send file to Feishu", {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async reportError(
    bot: FeishuBot,
    chatId: string,
    replyTo: string | undefined,
    error: unknown,
    mentions?: SendOptions["mentions"],
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    this.deps.logger.error("Conversation error", { chatId, error: message })
    this.deps.audit.record("error", { bot: bot.name, chatId, error: message })
    try {
      await bot.sendCard(chatId, errorCard(message), { replyTo, mentions })
    } catch (sendError) {
      this.deps.logger.error("Failed to report conversation error", {
        chatId,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      })
    }
  }

  /**
   * Start the recovery sweep. Bound sessions whose turn has already ended but
   * whose latest assistant answer was never delivered — because the turn timed
   * out, or the bridge restarted while the session was still running — get
   * that answer pushed to the chat as a plain message.
   */
  startRecovery(intervalMs = 30_000): void {
    if (this.recoveryTimer) return
    this.recoveryTimer = setInterval(() => {
      void this.sweepRecovery()
    }, intervalMs)
    this.recoveryTimer.unref?.()
    // A restart drops the live event stream while OpenCode keeps working.
    // Keep painting the same card from the server transcript until that work ends.
    this.followTimer = setInterval(() => {
      void this.followRunning()
    }, 3_000)
    this.followTimer.unref?.()
    // A killed process (tsx reload, crash) can orphan throwaway pregen sessions
    // before their finally-block deleteSession runs — sweep them so they never
    // pile up in the OpenCode backend. Hourly, plus once right now.
    void this.sweepOrphanPregenSessions()
    this.pregenSweepTimer = setInterval(() => {
      void this.sweepOrphanPregenSessions()
    }, 60 * 60_000)
    this.pregenSweepTimer.unref?.()
    // Seed pre-existing conversations first: bindings created before this
    // feature have no watermark, and we must not re-push their already-seen
    // answers. Only progress made after seeding is eligible for recovery.
    void this.seedRecoveryWatermarks()
      .catch((error) => {
        this.deps.logger.warn("Failed to seed recovery watermarks", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        void this.sweepRecovery()
      })
  }

  /**
   * One-time pass: record the latest assistant answer of every binding that
   * predates the watermark feature as "already delivered", so the sweep does
   * not re-send historical replies after an upgrade.
   */
  private async seedRecoveryWatermarks(): Promise<void> {
    const pending = this.deps.bindings.all().filter((binding) => !binding.lastDeliveredMessageID)
    if (pending.length === 0) return
    const client = await this.deps.opencode.client()
    let active: Record<string, unknown> = {}
    try {
      active = await client.listActiveSessions()
    } catch {
      active = {}
    }
    for (const binding of pending) {
      try {
        const messages = await client.messages(binding.sessionID)
        const running = Object.prototype.hasOwnProperty.call(active, binding.sessionID)
        // An in-flight assistant message is not delivered yet. Marking it as
        // delivered hides the step that is still on screen.
        const mark = running ? deliveredBeforeTurn(messages) : lastAssistantMessage(messages)?.id
        if (!mark) continue
        binding.lastDeliveredMessageID = mark
        binding.updatedAt = Date.now()
        this.deps.bindings.set(binding)
        this.deps.logger.info("Seeded recovery watermark", {
          bot: binding.bot,
          chatId: binding.chatId,
          sessionID: binding.sessionID,
          messageID: mark,
        })
      } catch {
        // Leave unseeded; a transient failure may cause a one-off resend.
      }
    }
  }

  stopRecovery(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer)
      this.recoveryTimer = undefined
    }
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = undefined
    }
    if (this.pregenSweepTimer) {
      clearInterval(this.pregenSweepTimer)
      this.pregenSweepTimer = undefined
    }
  }

  /**
   * Delete orphaned cron-pregen throwaway sessions from the OpenCode backend.
   * pregenerate() deletes its session in a finally block, but a process kill
   * skips that — these orphans serve no purpose (recovery ignores them) and
   * accumulate in the session list. Only sessions older than an hour are
   * removed, so a pregen currently in flight is never touched. Stale
   * cron-pregen binding records are dropped alongside.
   */
  private async sweepOrphanPregenSessions(): Promise<void> {
    let sessions: SessionInfo[]
    try {
      const client = await this.deps.opencode.client()
      sessions = await client.listSessions({ limit: 500 })
    } catch {
      return
    }
    const cutoff = Date.now() - 60 * 60_000
    const orphans = sessions.filter((session) => {
      const ephemeral = session.metadata?.ephemeral
      // 主会话双保险：它创建时必带 metadata.userId 且标题为「飞书私聊/群聊 …」，
      // 两个条件都碰不到；标题兜底分支再要求无 userId，绝不误伤用户会话。
      const isPregen =
        ephemeral === "cron-pregen" || ((session.title ?? "").startsWith("定时预生成") && !session.metadata?.userId)
      return isPregen && session.time.created < cutoff
    })
    for (const orphan of orphans) {
      try {
        const client = await this.deps.opencode.client()
        await client.deleteSession(orphan.id)
      } catch {
        /* already gone — fine */
      }
    }
    // Stale bridge-side binding records whose OpenCode session is long gone.
    let staleBindings = 0
    for (const binding of this.deps.bindings.all()) {
      if (!binding.key.startsWith("cron-pregen")) continue
      this.deps.bindings.delete(binding.key)
      staleBindings++
    }
    if (orphans.length || staleBindings) {
      this.deps.logger.info("Swept cron-pregen orphans", { sessions: orphans.length, bindings: staleBindings })
      this.deps.audit.record("cron.pregen.sweep", { sessions: orphans.length, bindings: staleBindings })
    }
  }

  /**
   * Sessions still running after the live stream died. Paint the same card from
   * the server transcript so the chat does not stay on the last frame.
   */
  private async followRunning(): Promise<void> {
    let active: Record<string, unknown>
    try {
      const client = await this.deps.opencode.client()
      active = await client.listActiveSessions()
    } catch {
      return
    }
    for (const binding of this.deps.bindings.all()) {
      const sessionID = binding.sessionID
      if (!sessionID || !binding.progressCardID) continue
      if (this.contexts.has(sessionID) || this.recovering.has(sessionID) || this.following.has(sessionID)) continue
      if (!Object.prototype.hasOwnProperty.call(active, sessionID)) continue
      this.following.add(sessionID)
      try {
        await this.followProgress(binding)
      } catch (error) {
        this.deps.logger.warn("Failed to follow progress card", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
          detail: errorDetail(error),
        })
      } finally {
        this.following.delete(sessionID)
      }
    }
  }

  private async followProgress(binding: Binding): Promise<void> {
    const cardID = binding.progressCardID
    if (!cardID) return
    const bot = this.deps.bots.get(binding.bot)
    if (!bot) return
    const client = await this.deps.opencode.client()
    const messages = await client.messages(binding.sessionID)
    const progress = new TurnAccumulator(true, false)
    const boundary = deliveredBeforeTurn(messages) ?? binding.lastDeliveredMessageID
    progress.absorb(transcriptFrom(messages, olderAssistantIDs(messages, boundary)))
    const rendered = fitCardMarkdown(progress.render("live"))
    if (!rendered.trim() || this.followedBody.get(binding.sessionID) === rendered) return
    await bot.pushProgressCard(cardID, rendered)
    this.followedBody.set(binding.sessionID, rendered)
  }

  private async sweepRecovery(): Promise<void> {
    const bindings = this.deps.bindings.all()
    if (bindings.length === 0) return
    let active: Record<string, unknown>
    try {
      const client = await this.deps.opencode.client()
      active = await client.listActiveSessions()
    } catch {
      return
    }
    for (const binding of bindings) {
      const sessionID = binding.sessionID
      if (!sessionID) continue
      // cron 预生成的一次性会话：结果只由 scheduler 到点投递。进程中断时
      // pregenerate 的 deleteSession 来不及执行，孤儿会话若被 recovery 当成
      // 漏发补发，用户就会在订阅时点之前收到草稿——绝不补发。
      if (binding.key.startsWith("cron-pregen")) continue
      // Skip anything that is still owned by a live turn, still running, or
      // blocked on a form/permission.
      if (this.contexts.has(sessionID)) continue
      if (Object.prototype.hasOwnProperty.call(active, sessionID)) continue
      if (this.interactionProbe(sessionID)) continue
      if (this.recovering.has(sessionID)) continue
      this.recovering.add(sessionID)
      try {
        await this.recoverBinding(binding)
        await this.deliverMissedMarkers(binding)
      } catch (error) {
        this.deps.logger.warn("Recovery sweep failed for session", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        this.recovering.delete(sessionID)
      }
    }
  }

  private async recoverBinding(binding: Binding): Promise<void> {
    const bot = this.deps.bots.get(binding.bot)
    if (!bot) return
    const client = await this.deps.opencode.client()
    let messages: MessageInfo[]
    try {
      messages = await client.messages(binding.sessionID)
    } catch {
      return
    }
    const last = lastAssistantMessage(messages)
    if (!last || last.id === binding.lastDeliveredMessageID) return
    const progress = new TurnAccumulator(true, false)
    const turn = transcriptFrom(messages, olderAssistantIDs(messages, binding.lastDeliveredMessageID))
    progress.absorb(turn)
    // Read markers from the raw reply. Stripping them for the card first would
    // drop the file, which is how a finished deck stayed out of the chat.
    const raw = turn.map((message) => message.text).filter((text) => text.length > 0).join("\n\n") || last.text
    const extracted = extractFileMarkers(raw)
    const rendered =
      cardMentionPrefix(binding.chatType, binding.userId) +
      fitCardMarkdown(styleRouteFooter(extractFileMarkers(progress.render() || raw).text || extracted.text))
    if (rendered.trim().length === 0 && extracted.files.length === 0) return
    this.deps.logger.warn("Delivering reply that outlived its turn", {
      bot: binding.bot,
      chatId: binding.chatId,
      sessionID: binding.sessionID,
    })
    // Prefer rewriting the card that is still spinning. A new message is only
    // the fallback when that card can no longer be updated.
    let updated = false
    if (binding.progressCardID) {
      try {
        await bot.finishProgressCard(binding.progressCardID, rendered)
        updated = true
      } catch (error) {
        this.deps.logger.warn("Failed to finish progress card", {
          error: error instanceof Error ? error.message : String(error),
          detail: errorDetail(error),
        })
      }
    } else if (binding.progressMessageID) {
      try {
        await bot.updateCard(binding.progressMessageID, markdownCard(progress.headline(), rendered))
        updated = true
      } catch (error) {
        this.deps.logger.warn("Failed to patch progress card", {
          error: error instanceof Error ? error.message : String(error),
          detail: errorDetail(error),
        })
      }
    }
    if (!updated) await bot.sendCard(binding.chatId, markdownCard(progress.headline(), rendered))
    this.clearProgress(binding)
    binding.lastDeliveredMessageID = last.id
    binding.updatedAt = Date.now()
    this.deps.bindings.set(binding)
    this.deps.audit.record("reply.recovered", {
      bot: binding.bot,
      chatId: binding.chatId,
      sessionID: binding.sessionID,
      messageID: last.id,
    })
    const startedAt = latestUserAt(messages)
    // A turn that outlived the process never ran the office conversion, so its
    // markdown would ship as-is. Build the requested office file first, then
    // suppress the draft exactly like the live path does.
    const officeSources: string[] = []
    const requestText = latestUserText(messages)
    if (startedAt > 0 && requestText) {
      try {
        const office = await emitRequestedOffice({
          directory: binding.directory,
          requestText,
          fileNames: [],
          startedAt,
        })
        for (const source of office.sources) officeSources.push(path.resolve(source))
      } catch (error) {
        this.deps.logger.warn("Failed to build office file during recovery", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const suppressMarkdown = startedAt > 0 && this.hasFreshOfficeOutput(binding.directory, startedAt)
    const outgoing = extracted.files.filter(
      (file) => !(suppressMarkdown && file.path.toLowerCase().endsWith(".md")),
    )
    const sent = await this.deliverFiles(bot, binding.chatId, outgoing)
    for (const source of officeSources) sent.add(source)
    if (startedAt > 0) await this.deliverFreshOutputs(bot, binding.directory, binding.chatId, startedAt, sent)
    this.rememberSent(binding, sent)
  }

  /**
   * The reply text can be marked delivered while its file upload was skipped.
   * Send any [[send-file]] target from the latest answer that has not gone out.
   */
  private async deliverMissedMarkers(binding: Binding): Promise<void> {
    const bot = this.deps.bots.get(binding.bot)
    if (!bot) return
    const client = await this.deps.opencode.client()
    let messages: MessageInfo[]
    try {
      messages = await client.messages(binding.sessionID)
    } catch {
      return
    }
    const last = lastAssistantMessage(messages)
    if (!last) return
    const known = new Set((binding.sentFilePaths ?? []).map((file) => path.resolve(file)))
    const pending = extractFileMarkers(last.text).files.filter((file) => !known.has(path.resolve(file.path)))
    if (pending.length === 0) return
    this.deps.logger.warn("Sending deliverable that was left off the chat", {
      sessionID: binding.sessionID,
      files: pending.map((file) => path.basename(file.path)),
    })
    const sent = await this.deliverFiles(bot, binding.chatId, pending)
    this.rememberSent(binding, sent)
  }

  private rememberSent(binding: Binding, sent: Set<string>): void {
    if (sent.size === 0) return
    const known = new Set(binding.sentFilePaths ?? [])
    let changed = false
    for (const file of sent) {
      const resolved = path.resolve(file)
      if (known.has(resolved)) continue
      known.add(resolved)
      changed = true
    }
    if (!changed) return
    binding.sentFilePaths = [...known]
    binding.updatedAt = Date.now()
    this.deps.bindings.set(binding)
    this.deps.bindings.flush()
  }

  private async latestAssistantMessageID(client: OpencodeClient, sessionID: string): Promise<string | undefined> {
    try {
      const messages = await client.messages(sessionID)
      return lastAssistantMessage(messages)?.id
    } catch {
      return undefined
    }
  }

  /** Wait until a session reports no active work (best-effort). */
  async waitIdle(sessionID: string, timeoutMs = 30_000): Promise<void> {
    const client = await this.deps.opencode.client()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const active = await client.listActiveSessions()
        if (!active || !Object.prototype.hasOwnProperty.call(active, sessionID)) return
      } catch {
        return
      }
      await sleep(1_000)
    }
  }
}

/** Pull a Feishu/axios response body out of an error for diagnostics. */
function errorDetail(error: unknown): unknown {
  const e = error as { response?: { status?: number; data?: unknown }; code?: string }
  if (e?.response) return { status: e.response.status, data: e.response.data }
  return undefined
}

/**
 * Latest assistant message that carries visible text, joining its text parts
 * (order-independent). Used to recover an answer whose turn already closed.
 */
function lastAssistantMessage(messages: MessageInfo[]): { id: string; text: string } | undefined {
  let best: { id: string; text: string; at: number } | undefined
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const at = message.time?.completed ?? message.time?.created ?? 0
    if (best && at < best.at) continue
    const parts = Array.isArray(message.content) ? message.content : []
    const text = parts
      .map((part) => (part && typeof part === "object" ? (part as { type?: string; text?: string }) : undefined))
      .filter((part): part is { type?: string; text?: string } => Boolean(part))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("")
    if (text.trim().length === 0) continue
    best = { id: message.id, text, at }
  }
  return best ? { id: best.id, text: best.text } : undefined
}

/** Short openers with no task words: answer with the capability card. */
const GREETING_WORDS = new Set([
  "你好", "您好", "你好呀", "嗨", "哈喽", "喂", "在吗", "在不在",
  "早上好", "上午好", "下午好", "晚上好",
  "hi", "hello", "hey", "help",
  "帮助", "菜单", "功能", "有什么功能",
  "你是谁", "你能做什么", "你会做什么", "你会什么", "你能干什么",
])

function isGreeting(text: string): boolean {
  const word = text.trim().toLowerCase().replace(/[。！？!?,，.~～\s]/g, "")
  if (word.length === 0 || word.length > 12) return false
  return GREETING_WORDS.has(word)
}

/** Task type from the orchestrator's fixed footer 「路由: 任务类型=X, …」. */
const ROUTE_LINE = /路由\s*[:：]\s*任务类型\s*=\s*([^,，\s|]+)/
/** Whole footer line, for dimming it inside the reply card. */
const ROUTE_LINE_FULL = /^(路由\s*[:：]\s*任务类型\s*=[^\n]+)$/gm

function routeFrom(text: string): string | undefined {
  if (!text) return undefined
  const match = ROUTE_LINE.exec(text)
  return match?.[1]?.trim() || undefined
}

/** 路由尾注弱化展示：灰色 + 斜体，与正文区分开（飞书流式卡片单元素不支持小字号）。 */
function styleRouteFooter(text: string): string {
  if (!text) return text
  return stripClosingPitch(text).replace(ROUTE_LINE_FULL, (_line, footer: string) => `<font color='grey'>*${footer.trim()}*</font>`)
}

/** Drop the menu pitch the model appends after a finished answer. */
function stripClosingPitch(text: string): string {
  const marker = /\n+(?:如果要做成对外的材料|后续入口|接下来你可以|你还可以[:：])/
  const match = marker.exec(text)
  if (!match) return text
  return text.slice(0, match.index).trimEnd()
}

/**
 * Best-effort extension for a downloaded Drive binary: magic bytes first,
 * then a peek inside the ZIP container to tell docx/xlsx/pptx apart.
 */
async function sniffOfficeExtension(buffer: Buffer): Promise<string> {
  if (buffer.length > 4 && buffer.toString("ascii", 0, 4) === "%PDF") return ".pdf"
  if (buffer.length > 8 && buffer.toString("hex", 0, 8) === "89504e470d0a1a0a") return ".png"
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg"
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      const JSZip = (await import("jszip")).default
      const zip = await JSZip.loadAsync(buffer)
      if (zip.file("word/document.xml")) return ".docx"
      if (zip.file("xl/workbook.xml")) return ".xlsx"
      if (zip.file("ppt/presentation.xml")) return ".pptx"
      return ".zip"
    } catch {
      return ".bin"
    }
  }
  return ".bin"
}

/** Best-effort extension for an incoming binary by sniffing magic bytes. */
function templatePathFrom(files: PromptFileAttachment[] | undefined): string | undefined {
  for (const file of files ?? []) {
    const raw = file.uri.startsWith("file:") ? fileURLToPath(file.uri) : file.uri
    const ext = path.extname(file.name || raw).toLowerCase()
    if (ext === ".pptx" && fs.existsSync(raw)) return raw
  }
  return undefined
}

function findSavedAttachment(dirs: string[], fileName: string): string | undefined {
  const safe = safeFileName(fileName)
  const legacy = safeSegment(fileName)
  const hits: string[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (
        name === safe ||
        name.endsWith(`_${safe}`) ||
        name === legacy ||
        name.endsWith(`_${legacy}`) ||
        name.endsWith(`_${fileName}`)
      ) {
        hits.push(path.join(dir, name))
      }
    }
  }
  hits.sort((a, b) => stampOf(b) - stampOf(a))
  return hits[0]
}

function stampOf(filePath: string): number {
  const match = /^(\d+)_/.exec(path.basename(filePath))
  return match?.[1] ? Number(match[1]) : 0
}

function copyIntoCache(cacheDir: string, source: string, fileName: string): void {
  const dest = path.join(cacheDir, `${Date.now()}_${safeFileName(fileName)}`)
  if (path.resolve(dest) === path.resolve(source)) return
  fs.copyFileSync(source, dest)
}

/** Drop files the previous task left in the working folder, so a new task cannot open them. */
function clearInbox(directory: string): void {
  const inbox = path.join(directory, "inbox")
  let names: string[]
  try {
    names = fs.readdirSync(inbox)
  } catch {
    return
  }
  for (const name of names) {
    fs.rmSync(path.join(inbox, name), { recursive: true, force: true })
  }
}

/** Put a saved copy in the session inbox. Returns the path the agent should read. */
function placeInInbox(inbox: string, source: string, fileName: string): string {
  ensureDir(inbox)
  const resolved = path.resolve(source)
  if (resolved.startsWith(path.resolve(inbox) + path.sep)) return source
  const dest = path.join(inbox, `${Date.now()}_${safeFileName(fileName)}`)
  fs.copyFileSync(source, dest)
  return dest
}

interface CachedFile {
  name: string
  path: string
  savedAt: number
}

function listCachedFiles(cacheDir: string): CachedFile[] {
  let names: string[]
  try {
    names = fs.readdirSync(cacheDir)
  } catch {
    return []
  }
  const files: CachedFile[] = []
  for (const entry of names) {
    const match = /^(\d+)_(.+)$/.exec(entry)
    if (!match?.[1] || !match[2]) continue
    if (/\.(txt|slots\.md)$/i.test(match[2])) continue
    files.push({ name: match[2], path: path.join(cacheDir, entry), savedAt: Number(match[1]) })
  }
  return files
}

function expectsAttachedFiles(text: string): boolean {
  return /这两个文件|这两份|这俩个文件|这俩份|那两个文件|刚才的文件|之前的文件|上传的|发的文件|附件|这两个材料/.test(text)
}

function asksForSpreadsheets(text: string): boolean {
  if (/生成|制作|做一个|导出成|做成/.test(text) && !/分析|统计|占比|个数/.test(text)) return false
  return /Excel|excel|xlsx|这三张表|这三个表|这三份表|三张表|三个表/.test(text)
}

function matchCachedFiles(text: string, files: CachedFile[]): CachedFile[] {
  const named = files.filter((file) => {
    const stem = file.name.replace(/\.[^.]+$/, "")
    return text.includes(file.name) || (stem.length >= 2 && text.includes(stem))
  })
  if (named.length > 0) return latestOf(named)
  const generic = /这两个文件|这两份|这俩个文件|这俩份|那两个文件|刚才的文件|之前的文件|上传的文件|发的文件|这些文件|那些文件|上一份|那份文件|附件/.test(text)
  if (!generic) return []
  const wantsDoc = true
  const wantsDeck = /模板|ppt|幻灯|汇报/.test(text.toLowerCase()) || generic
  const picked: CachedFile[] = []
  if (wantsDoc) {
    const doc = newest(files, (file) => /\.(doc|docx|pdf)$/i.test(file.name))
    if (doc) picked.push(doc)
  }
  if (wantsDeck) {
    const deck = newest(files, (file) => /\.pptx?$/i.test(file.name))
    if (deck) picked.push(deck)
  }
  return picked
}

function latestOf(files: CachedFile[]): CachedFile[] {
  const byName = new Map<string, CachedFile>()
  for (const file of files) {
    const current = byName.get(file.name)
    if (!current || file.savedAt > current.savedAt) byName.set(file.name, file)
  }
  return [...byName.values()]
}

function newest(files: CachedFile[], accept: (file: CachedFile) => boolean): CachedFile | undefined {
  let best: CachedFile | undefined
  for (const file of files) {
    if (!accept(file)) continue
    if (!best || file.savedAt > best.savedAt) best = file
  }
  return best
}

function guessExtension(buffer: Buffer, type: string): string {
  if (type === "image") {
    if (buffer.length >= 2 && buffer[0] === 0x89 && buffer[1] === 0x50) return ".png"
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg"
    if (buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return ".gif"
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
      return ".webp"
    }
    return ".png"
  }
  if (type === "audio") return ".mp3"
  if (type === "video") return ".mp4"
  return ""
}

const AGENT_LABEL: Record<string, string> = {
  "pm-a11-requirements": "A11 需求",
  "pm-a12-competitor": "A12 竞品",
  "pm-a13-market": "A13 市场",
  "pm-a21-rd": "A21 研发",
  "pm-a22-qa": "A22 测试",
  "pm-a23-release": "A23 发布",
  "pm-a31-ops": "A31 运营",
  "pm-a32-feedback": "A32 反馈",
  "pm-a41-leads": "A41 线索",
  "pm-a42-followup": "A42 跟进",
  "pm-a43-conversion": "A43 正文",
  "pm-a44-performance": "A44 业绩",
  "pm-a51-support": "A51 支持",
  "pm-a52-knowledge": "A52 知识",
  "pm-a53-partner": "A53 伙伴",
  "pm-a54-risk": "A54 风险",
  "pm-a81-opportunity": "A81 商机",
  "pm-a61-deliverable": "A61 成稿",
}

/** Assistant messages at or before the watermark, so recovery only renders this turn. */
/** Last assistant message from before the latest user turn, so an in-flight step stays visible. */
function latestUserAt(messages: MessageInfo[]): number {
  let at = 0
  for (const message of messages) {
    if (message.type === "user") at = Math.max(at, message.time?.created ?? 0)
  }
  return at
}

/** Newest user message, trimmed back to what the human actually typed. */
function latestUserText(messages: MessageInfo[]): string {
  let text = ""
  let at = 0
  for (const message of messages) {
    if (message.type !== "user") continue
    const created = message.time?.created ?? 0
    if (created >= at) {
      at = created
      text = message.text ?? ""
    }
  }
  // The stored prompt carries the attachment-preprocessing notes appended
  // after the user's words. They mention pptx/docx/pdf and would fool
  // requestedFormats into emitting every format.
  return (text.split("\n\n材料已预处理")[0] ?? "").trim()
}

function deliveredBeforeTurn(messages: MessageInfo[]): string | undefined {
  const sorted = [...messages].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  let lastUserAt = -1
  for (const message of sorted) {
    if (message.type === "user") lastUserAt = message.time?.created ?? lastUserAt
  }
  if (lastUserAt < 0) return lastAssistantMessage(messages)?.id
  let prior: string | undefined
  for (const message of sorted) {
    if (message.type !== "assistant" || !message.id) continue
    if ((message.time?.created ?? 0) >= lastUserAt) break
    prior = message.id
  }
  return prior
}

function olderAssistantIDs(messages: MessageInfo[], watermark?: string): Set<string> {
  const prior = new Set<string>()
  if (!watermark) return prior
  const sorted = [...messages].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  for (const message of sorted) {
    if (message.type === "assistant" && message.id) prior.add(message.id)
    if (message.id === watermark) break
  }
  return prior
}

function transcriptFrom(messages: MessageInfo[], priorMessageIDs?: Set<string>): TranscriptMessage[] {
  return messages
    .filter((message) => {
      if (message.type !== "assistant" || !message.id || !priorMessageIDs) return false
      return !priorMessageIDs.has(message.id)
    })
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
    .map((message) => {
      const parts = Array.isArray(message.content) ? message.content : []
      const text = parts
        .map((part) => {
          const item = part as { type?: string; text?: string }
          return item?.type === "text" && typeof item.text === "string" ? item.text.trim() : ""
        })
        .filter((line) => line.length > 0)
        .join("\n\n")
      const tools = parts.flatMap((part) => {
        const item = part as { type?: string; id?: string; tool?: string; state?: { status?: string; input?: unknown } }
        if (item?.type !== "tool" || typeof item.id !== "string") return []
        const name = labelForTool(item.tool || "tool", item.state?.input)
        if (!isAgentLabel(name)) return []
        return [
          {
            id: item.id,
            name,
            status: toolStatus(item.state?.status),
          },
        ]
      })
      return { id: message.id, text, tools }
    })
}

function toolStatus(status: unknown): string {
  const value = String(status ?? "").toLowerCase()
  if (value === "completed" || value === "complete" || value === "success") return "completed"
  if (value === "error" || value === "failed") return "error"
  return "running"
}

function agentIdFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const obj = input as Record<string, unknown>
  for (const key of ["agent", "subagent", "subagent_type", "name", "agentName"]) {
    const value = obj[key]
    if (typeof value === "string" && value.startsWith("pm-a")) return value
  }
  const match = JSON.stringify(obj).match(/pm-a(?:11|12|13|21|22|23|31|32|41|42|43|44|51|52|53|54|61|81)-[a-z]+/)
  return match?.[0]
}

function isAgentLabel(label: string | undefined): label is string {
  return typeof label === "string" && label.startsWith("调用")
}

function labelForTool(toolName: string, input: unknown): string {
  if (isAgentLabel(toolName)) return toolName
  const agent = agentIdFromInput(input)
  if (agent) return `调用 ${AGENT_LABEL[agent] ?? agent}`
  if (toolName === "subagent" || toolName === "task") return "调用子 Agent"
  return toolName
}

function errorCard(message: string): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "❌ 出错了" }, template: "red" },
    body: { elements: [{ tag: "markdown", content: message }] },
  }
}
