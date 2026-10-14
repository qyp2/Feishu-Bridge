import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { MarkdownStreamController, NormalizedMessage } from "@larksuiteoapi/node-sdk"
import type { AppConfig } from "../config/index.js"
import type { AuditLog, Logger } from "../util/logger.js"
import type { OpencodeService } from "../opencode/service.js"
import type { OpencodeEventBus } from "../opencode/events.js"
import type { OpencodeClient } from "../opencode/client.js"
import { BindingStore, type Binding } from "../storage/bindings.js"
import type { FeishuBot } from "../feishu/bot.js"
import type { OpencodeEvent, PromptFileAttachment } from "../opencode/types.js"
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
import { ensureDir, ensureProjectLink, safeSegment } from "../util/paths.js"
import { ensureInstructions, extractFileMarkers } from "./instructions.js"
import { TurnAccumulator } from "./turn.js"
import { CommandHandler } from "./commands.js"

export interface SessionContext {
  botName: string
  chatId: string
  replyTo?: string
}

interface TurnState {
  accumulator: TurnAccumulator
  toolNames: Map<string, string>
  sawEvent: boolean
  idleStrikes: number
  /** Last time the session showed progress (event received or observed busy). */
  lastActivity: number
  /** ID of the most recent assistant message seen in the event stream. */
  lastAssistantMessageID?: string
  signalRender: () => void
  settle: (error?: string) => void
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
// Inactivity window: a turn is only abandoned after this long with no
// progress at all. Legitimate long runs (e.g. a 16-sub-agent mission) keep the
// session `active`, which continuously renews the window.
const TURN_IDLE_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Placeholder forms the Lark SDK inserts for non-text resources:
 * `![image](imageKey)` for images and self-closing tags such as
 * `<file key="..." name="..."/>`, `<audio .../>`, `<video .../>`,
 * `<sticker .../>`, `<folder .../>`. They must be removed before deciding
 * whether a message carries an actual text instruction, otherwise a file-only
 * message looks like a text prompt and is sent to the agent immediately.
 */
const RESOURCE_PLACEHOLDER = /!\[[^\]]*\]\([^)]*\)|<(?:file|audio|video|media|sticker|folder)\b[^>]*\/?>/gi

function stripResourcePlaceholders(input: string): string {
  return input.replace(RESOURCE_PLACEHOLDER, "").trim()
}

/**
 * Orchestrates the lifecycle of a conversation: binding a Feishu chat to an
 * OpenCode session, forwarding prompts, streaming the reply into a card, and
 * delivering files the agent produced.
 */
export class ConversationService {
  private readonly serial = new KeyedSerial()
  private readonly contexts = new Map<string, SessionContext>()
  private readonly commands: CommandHandler
  private readonly linkedProjects = new Set<string>()
  private interactionProbe: (sessionID: string) => boolean = () => false
  private recoveryTimer?: NodeJS.Timeout
  private readonly recovering = new Set<string>()

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

  // ---- entry point --------------------------------------------------------

  async handleMessage(bot: FeishuBot, msg: NormalizedMessage): Promise<void> {
    const rawText = (msg.content ?? "").trim()
    // Drop the placeholders the Lark normalizer inserts for media resources
    // (images and file/audio/video/sticker tags); the actual files are
    // downloaded and attached separately. Without this a file-only message
    // looks like a text instruction and is sent to the agent right away.
    const text = stripResourcePlaceholders(rawText)
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
    // tail; we keep per-chat ordering ourselves via the keyed serial runner.
    void this.serial.run(`msg:${bot.name}:${msg.chatId}`, () => this.processMessage(bot, identity, msg, text))
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
      const binding = await this.ensureSession(bot, identity, msg.chatId)
      const incoming = await this.prepareAttachments(bot, msg, binding)
      const held = binding.pendingAttachments ?? []

      // A text instruction: attach anything previously held, then run the turn.
      if (text.length > 0) {
        if (held.length > 0) {
          binding.pendingAttachments = []
          this.deps.bindings.set(binding)
        }
        await this.runTurn({
          bot,
          binding,
          replyTo: msg.messageId,
          text,
          files: [...held, ...incoming],
          source: "user",
        })
        return
      }

      // Files sent without text: hold them and wait for the instruction.
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
        })
        return
      }
      // No text and no files: nothing to do.
    } catch (error) {
      await this.reportError(bot, msg.chatId, msg.messageId, error)
    }
  }

  /** Let the user know their files were received and are waiting for an instruction. */
  private async acknowledgeAttachments(
    bot: FeishuBot,
    msg: NormalizedMessage,
    files: PromptFileAttachment[],
  ): Promise<void> {
    const names = files.map((file) => file.name ?? "文件").join("、")
    const body = `📎 已收到 ${files.length} 个文件：${names}\n\n请告诉我你想让我做什么，我再开始处理。`
    await bot.sendMarkdown(msg.chatId, body, { replyTo: msg.messageId }).catch((error) => {
      this.deps.logger.warn("Failed to acknowledge attachments", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** Run a scheduled prompt against a chat as if the user sent it. */
  async runScheduled(bot: FeishuBot, chatId: string, prompt: string, userId?: string): Promise<void> {
    const identity: ChatIdentity = {
      chatId,
      chatType: userId ? "group" : "p2p",
      senderId: userId ?? "cron",
      senderName: "cron",
    }
    const binding = await this.ensureSession(bot, identity, chatId)
    await this.runTurn({ bot, binding, text: prompt, source: "cron" })
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
        if (session?.id) return existing
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
    const title = identity.chatType === "p2p" ? `飞书私聊 ${identity.senderName ?? identity.senderId}` : `飞书群聊 ${identity.chatId}`
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
    this.deps.audit.record("session.created", { bot: bot.name, chatId: identity.chatId, sessionID: session.id, directory })
    return binding
  }

  async resetSession(bot: FeishuBot, identity: ChatIdentity): Promise<Binding> {
    const key = this.bindingKey(bot, identity)
    const existing = this.deps.bindings.get(key)
    if (existing) {
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
    ensureDir(inbox)
    for (const resource of msg.resources) {
      if (resource.type !== "image" && resource.type !== "file" && resource.type !== "audio" && resource.type !== "video") {
        this.deps.logger.info("Skipping unsupported incoming resource", { type: resource.type })
        continue
      }
      try {
        const buffer = await bot.downloadMessageResource(msg.messageId, resource.fileKey, resource.type)
        if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
          this.deps.logger.warn("Attachment exceeds size limit", { fileKey: resource.fileKey, size: buffer.byteLength })
          continue
        }
        const name = resource.fileName ?? `${resource.type}_${safeSegment(resource.fileKey)}${guessExtension(buffer, resource.type)}`
        const local = path.join(inbox, `${Date.now()}_${safeSegment(name)}`)
        fs.writeFileSync(local, buffer)
        files.push({ uri: pathToFileURL(local).href, name })
      } catch (error) {
        this.deps.logger.warn("Failed to download attachment", {
          fileKey: resource.fileKey,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return files
  }

  // ---- the turn -----------------------------------------------------------

  async runTurn(request: TurnRequest): Promise<void> {
    const { bot, binding } = request
    await this.serial.run(binding.key, async () => {
      const client = await this.deps.opencode.client()
      const accumulator = new TurnAccumulator(bot.config.streaming.showTools, bot.config.streaming.showReasoning)
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
      const settle = (error?: string) => {
        if (settled) return
        settled = true
        failure = error ?? failure
        resolveCompletion()
      }

      const state: TurnState = {
        accumulator,
        toolNames: new Map(),
        sawEvent: false,
        idleStrikes: 0,
        lastActivity: Date.now(),
        signalRender,
        settle,
      }

      let streamMessageId: string | undefined
      const producer = async (controller: MarkdownStreamController): Promise<void> => {
        if (controller.messageId) streamMessageId = controller.messageId
        await controller.setContent("🤔 正在思考…").catch(() => {})
        for await (const _ of renderQueue) {
          const content = accumulator.render()
          await controller.setContent(content.length > 0 ? content : "🤔 正在思考…").catch(() => {})
          if (closed) break
        }
      }

      const context: SessionContext = { botName: bot.name, chatId: binding.chatId, replyTo: request.replyTo }
      this.contexts.set(binding.sessionID, context)

      const streamPromise = bot
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

      try {
        await client.prompt(binding.sessionID, {
          text: request.text,
          files: request.files,
        })
        binding.updatedAt = Date.now()
        this.deps.bindings.set(binding)
        this.deps.audit.record("prompt.sent", {
          bot: bot.name,
          chatId: binding.chatId,
          sessionID: binding.sessionID,
          source: request.source,
          text: request.text.slice(0, 500),
          attachments: request.files?.length ?? 0,
        })
        await completion
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
        settle(failure)
      } finally {
        clearInterval(watchdog)
        unsubscribe()
      }

      // Reconcile with the server transcript in case we missed events.
      await this.reconcile(client, binding.sessionID, accumulator)
      closed = true
      if (failure) {
        const current = accumulator.render()
        accumulator.setText("error", 0, current ? `${current}\n\n> ⚠️ ${failure}` : `> ⚠️ ${failure}`)
      }
      signalRender()
      renderQueue.push()
      renderQueue.close()
      await streamPromise

      let delivered = Boolean(streamMessageId) && accumulator.hasContent

      // If the streaming card never opened, still deliver the reply as a
      // plain message so the user always gets an answer.
      if (!streamMessageId) {
        const fallback = accumulator.render()
        if (fallback.trim().length > 0) {
          try {
            await bot.sendMarkdownResilient(binding.chatId, fallback, { replyTo: request.replyTo })
            delivered = true
          } catch (error) {
            this.deps.logger.error("Failed to send fallback reply", {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }

      const { files } = extractFileMarkers(accumulator.text)
      await this.deliverFiles(bot, binding.chatId, files, request.replyTo)

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
      this.contexts.delete(binding.sessionID)
    })
  }

  private onEvent(event: OpencodeEvent, sessionID: string, state: TurnState): void {
    const data = event.data as Record<string, unknown> | undefined
    if (!data || data.sessionID !== sessionID) return
    const { accumulator, toolNames, signalRender, settle } = state
    state.sawEvent = true
    state.lastActivity = Date.now()
    const messageID = (data as { assistantMessageID?: string }).assistantMessageID
    if (messageID) state.lastAssistantMessageID = messageID
    switch (event.type) {
      case "session.text.delta": {
        const d = data as unknown as TextDeltaData
        accumulator.addText(d.assistantMessageID, d.ordinal, d.delta)
        signalRender()
        break
      }
      case "session.text.ended": {
        const d = data as unknown as TextEndedData
        accumulator.setText(d.assistantMessageID, d.ordinal, d.text)
        signalRender()
        break
      }
      case "session.reasoning.delta": {
        const d = data as unknown as ReasoningDeltaData
        accumulator.addReasoning(d.delta)
        signalRender()
        break
      }
      case "session.tool.input.started": {
        const d = data as unknown as ToolInputStartedData
        toolNames.set(d.id, d.name)
        accumulator.setTool(d.id, d.name, "running")
        signalRender()
        break
      }
      case "session.tool.called": {
        const d = data as unknown as ToolCalledData
        const detail = d.input ? summariseInput(d.input) : undefined
        accumulator.setTool(d.id, toolNames.get(d.id) ?? "tool", "running", detail)
        signalRender()
        break
      }
      case "session.tool.progress": {
        const d = data as unknown as ToolProgressData
        const call = d.metadata?.toolCalls?.[0]
        if (call) {
          toolNames.set(d.id, call.tool)
          accumulator.setTool(d.id, call.tool, call.status === "completed" ? "completed" : "running")
        }
        signalRender()
        break
      }
      case "session.tool.success":
      case "session.tool.error": {
        const d = data as unknown as ToolCalledData
        accumulator.setTool(d.id, toolNames.get(d.id) ?? "tool", event.type.endsWith("error") ? "error" : "completed")
        signalRender()
        break
      }
      case "session.execution.succeeded": {
        signalRender()
        // If the agent is paused on a question form or permission, keep the turn
        // open so the reply to the user's answer is streamed to the same card.
        if (!this.interactionProbe(sessionID)) settle()
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
    // Give up only after a full window with no progress whatsoever. A session
    // that is still running renews this below, so long multi-agent missions are
    // never cut off mid-flight.
    if (now - state.lastActivity > TURN_IDLE_TIMEOUT_MS) {
      this.deps.logger.warn("Turn abandoned after inactivity", {
        sessionID,
        idleMs: now - state.lastActivity,
      })
      state.settle("执行超时，已停止等待回复。")
      return
    }
    if (!state.sawEvent) return
    // Never treat a session blocked on a form/permission as finished.
    if (this.interactionProbe(sessionID)) {
      state.idleStrikes = 0
      return
    }
    try {
      const active = await client.listActiveSessions()
      const busy = active && Object.prototype.hasOwnProperty.call(active, sessionID)
      if (busy) {
        state.idleStrikes = 0
        state.lastActivity = now
        return
      }
      // Require two consecutive idle observations to avoid settling during a
      // brief gap between steps.
      state.idleStrikes += 1
      if (state.idleStrikes >= 2) state.settle()
    } catch {
      // transient; the event stream or inactivity window will settle the turn
    }
  }

  private async reconcile(client: OpencodeClient, sessionID: string, accumulator: TurnAccumulator): Promise<void> {
    if (accumulator.hasContent) return
    try {
      const log = await client.sessionLog(sessionID)
      const messages = log?.messages ?? []
      for (const message of messages) {
        if (message.type !== "assistant" || !Array.isArray(message.content)) continue
        for (const part of message.content as { type?: string; text?: string }[]) {
          if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
            accumulator.setText(message.id, 0, part.text)
          }
        }
      }
    } catch {
      // ignore; an empty reply is acceptable
    }
  }

  private async deliverFiles(
    bot: FeishuBot,
    chatId: string,
    files: { kind: "file" | "image"; path: string }[],
    replyTo?: string,
  ): Promise<void> {
    for (const file of files) {
      try {
        if (!fs.existsSync(file.path)) {
          this.deps.logger.warn("Agent referenced a missing file", { path: file.path })
          continue
        }
        if (file.kind === "image") {
          await bot.sendImage(chatId, file.path, { replyTo })
        } else {
          await bot.sendFile(chatId, file.path, path.basename(file.path), { replyTo })
        }
        this.deps.audit.record("file.sent", { chatId, path: file.path, kind: file.kind })
      } catch (error) {
        this.deps.logger.warn("Failed to send file to Feishu", {
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async reportError(bot: FeishuBot, chatId: string, replyTo: string | undefined, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    this.deps.logger.error("Conversation error", { chatId, error: message })
    this.deps.audit.record("error", { bot: bot.name, chatId, error: message })
    try {
      await bot.sendCard(chatId, errorCard(message), { replyTo })
    } catch {
      // give up silently
    }
  }

  // ---- orphaned-completion recovery --------------------------------------

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
    for (const binding of pending) {
      try {
        const messages = await client.messages(binding.sessionID)
        const last = lastAssistantMessage(messages)
        if (!last) continue
        binding.lastDeliveredMessageID = last.id
        binding.updatedAt = Date.now()
        this.deps.bindings.set(binding)
        this.deps.logger.info("Seeded recovery watermark", {
          bot: binding.bot,
          chatId: binding.chatId,
          sessionID: binding.sessionID,
          messageID: last.id,
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
      // Skip anything that is still owned by a live turn, still running, or
      // blocked on a form/permission.
      if (this.contexts.has(sessionID)) continue
      if (Object.prototype.hasOwnProperty.call(active, sessionID)) continue
      if (this.interactionProbe(sessionID)) continue
      if (this.recovering.has(sessionID)) continue
      this.recovering.add(sessionID)
      try {
        await this.recoverBinding(binding)
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
    if (!last || last.text.trim().length === 0) return
    if (last.id === binding.lastDeliveredMessageID) return

    const { text, files } = extractFileMarkers(last.text)
    this.deps.logger.warn("Delivering reply that outlived its turn", {
      bot: binding.bot,
      chatId: binding.chatId,
      sessionID: binding.sessionID,
      messageID: last.id,
    })
    // Send first; only advance the watermark once delivery actually succeeded
    // so a transient failure is retried on the next sweep.
    await bot.sendMarkdownResilient(binding.chatId, text)
    binding.lastDeliveredMessageID = last.id
    binding.updatedAt = Date.now()
    this.deps.bindings.set(binding)
    this.deps.audit.record("reply.recovered", {
      bot: binding.bot,
      chatId: binding.chatId,
      sessionID: binding.sessionID,
      messageID: last.id,
    })
    if (files.length > 0) await this.deliverFiles(bot, binding.chatId, files)
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

/** Best-effort extension for an incoming binary by sniffing magic bytes. */
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

function summariseInput(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>
    if (typeof obj.command === "string") return obj.command
    if (typeof obj.code === "string") return obj.code
    if (typeof obj.query === "string") return obj.query
    if (typeof obj.filePath === "string") return obj.filePath
    if (typeof obj.path === "string") return obj.path
    const keys = Object.keys(obj)
    if (keys.length > 0) return keys.join(", ")
  }
  return String(input)
}

function errorCard(message: string): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "❌ 出错了" }, template: "red" },
    body: { elements: [{ tag: "markdown", content: message }] },
  }
}
