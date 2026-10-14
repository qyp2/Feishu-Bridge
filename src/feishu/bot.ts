import * as Lark from "@larksuiteoapi/node-sdk"
import type {
  CardActionEvent,
  ChatInfo,
  LarkChannel,
  NormalizedMessage,
  RejectEvent,
  SendOptions,
  SendResult,
} from "@larksuiteoapi/node-sdk"
import type { BotConfig } from "../config/index.js"
import type { Logger } from "../util/logger.js"

export type {
  CardActionEvent,
  ChatInfo,
  NormalizedMessage,
  RejectEvent,
  SendOptions,
  SendResult,
} from "@larksuiteoapi/node-sdk"

export interface BotHandlers {
  onMessage: (message: NormalizedMessage) => void | Promise<void>
  onCardAction: (event: CardActionEvent) => void | Promise<void>
  onReject?: (event: RejectEvent) => void
  onError?: (error: Error) => void
  onReconnected?: () => void
}

/**
 * One Feishu/Lark bot: owns a long-connection channel for its app credentials.
 *
 * Uses the SDK's high level `LarkChannel`, which handles the WebSocket
 * transport, event normalization, mention/allow-list policy, streaming cards,
 * media upload/download and card interactions.
 */
export class FeishuBot {
  readonly name: string
  readonly config: BotConfig
  readonly channel: LarkChannel
  private readonly logger: Logger
  private readonly handlers: BotHandlers
  private connected = false

  constructor(config: BotConfig, logger: Logger, handlers: BotHandlers) {
    this.config = config
    this.name = config.name
    this.logger = logger.child(`bot:${config.name}`)
    this.handlers = handlers
    this.channel = Lark.createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      transport: "websocket",
      includeRawEvent: true,
      loggerLevel: Lark.LoggerLevel.warn,
      policy: {
        groupAllowlist: config.access.allowChats,
        dmMode: config.access.allowUsers.length > 0 ? "allowlist" : "open",
        dmAllowlist: config.access.allowUsers,
        requireMention: config.requireMention,
      },
      outbound: {
        streamThrottleMs: config.streaming.intervalMs,
        allowedFileDirs: config.location ? [config.location] : undefined,
      },
      source: "feishu-bridge",
    })
  }

  get log(): Logger {
    return this.logger
  }

  async connect(): Promise<void> {
    this.channel.on("message", (message) => this.handlers.onMessage(message))
    this.channel.on("cardAction", (event) => this.handlers.onCardAction(event))
    this.channel.on("reject", (event) => this.handlers.onReject?.(event))
    this.channel.on("error", (error) => {
      this.logger.error("Channel error", { code: error.code, message: error.message })
      this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
    })
    this.channel.on("reconnected", () => {
      this.logger.info("Feishu channel reconnected")
      this.handlers.onReconnected?.()
    })
    await this.channel.connect()
    this.connected = true
    this.logger.info("Feishu long connection established", { appId: this.config.appId })
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    this.connected = false
    await this.channel.disconnect()
  }

  isConnected(): boolean {
    return this.connected
  }

  async sendMarkdown(to: string, markdown: string, opts?: SendOptions): Promise<SendResult> {
    return this.channel.send(to, { markdown }, opts)
  }

  async sendText(to: string, text: string, opts?: SendOptions): Promise<SendResult> {
    return this.channel.send(to, { text }, opts)
  }

  async sendCard(to: string, card: object, opts?: SendOptions): Promise<SendResult> {
    return this.channel.send(to, { card }, opts)
  }

  /**
   * Send markdown, falling back to a plain (non-reply) message when replying
   * fails. The usual cause is a withdrawn reply target: the SDK only retries
   * without `replyTo` for some revoked-message error shapes, so we recover here
   * rather than dropping the reply entirely.
   */
  async sendMarkdownResilient(to: string, markdown: string, opts?: SendOptions): Promise<SendResult> {
    if (!opts?.replyTo) return this.sendMarkdown(to, markdown, opts)
    try {
      return await this.sendMarkdown(to, markdown, opts)
    } catch (error) {
      this.logger.debug("Markdown reply failed; sending without reply target", { error: messageOf(error) })
      return this.sendMarkdown(to, markdown, { ...opts, replyTo: undefined })
    }
  }

  /** Send a card, retrying without `replyTo` when replying fails (see sendMarkdownResilient). */
  async sendCardResilient(to: string, card: object, opts?: SendOptions): Promise<SendResult> {
    if (!opts?.replyTo) return this.sendCard(to, card, opts)
    try {
      return await this.sendCard(to, card, opts)
    } catch (error) {
      this.logger.debug("Card reply failed; sending without reply target", { error: messageOf(error) })
      return this.sendCard(to, card, { ...opts, replyTo: undefined })
    }
  }

  async sendFile(to: string, source: string, fileName: string, opts?: SendOptions): Promise<SendResult> {
    return this.channel.send(to, { file: { source, fileName } }, opts)
  }

  async sendImage(to: string, source: string, opts?: SendOptions): Promise<SendResult> {
    return this.channel.send(to, { image: { source } }, opts)
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    return this.channel.updateCard(messageId, card)
  }

  async downloadResource(fileKey: string, type: "image" | "file"): Promise<Buffer> {
    return this.channel.downloadResource(fileKey, type)
  }

  /**
   * Download an image/file that a user sent inside a message.
   *
   * The channel's `downloadResource` uses `im.v1.image.get`, which only works
   * for images uploaded by the app itself. User-sent resources must be fetched
   * via `im.v1.messageResource.get`, which is scoped to the originating
   * `message_id`.
   */
  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: "image" | "file" | "audio" | "video",
  ): Promise<Buffer> {
    const raw = await this.raw.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    })
    return streamToBuffer(raw)
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return this.channel.getChatInfo(chatId)
  }

  stream(
    to: string,
    input: Parameters<LarkChannel["stream"]>[1],
    opts?: SendOptions,
  ): Promise<SendResult> {
    return this.channel.stream(to, input, opts)
  }

  /** Low level client for card entity / message APIs the channel does not wrap. */
  get raw(): Lark.Client {
    return this.channel.rawClient
  }
}

/** Consume the SDK's download wrapper (`{ writeFile, getReadableStream }`) into a Buffer. */
function streamToBuffer(raw: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(raw)) return Promise.resolve(raw)
  if (raw instanceof Uint8Array) return Promise.resolve(Buffer.from(raw))
  const wrapper = raw as { getReadableStream?: () => NodeJS.ReadableStream; data?: unknown } | null
  if (wrapper && typeof wrapper.getReadableStream === "function") {
    const stream = wrapper.getReadableStream()
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)))
      stream.on("end", () => resolve(Buffer.concat(chunks)))
      stream.on("error", reject)
    })
  }
  if (wrapper && Buffer.isBuffer(wrapper.data)) return Promise.resolve(wrapper.data)
  throw new Error("unexpected download response type")
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
