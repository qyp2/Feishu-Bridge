import path from "node:path"
import type { LoadedConfig } from "./config/index.js"
import { Logger, AuditLog } from "./util/logger.js"
import { ensureDir } from "./util/paths.js"
import { OpencodeService } from "./opencode/service.js"
import { OpencodeEventBus } from "./opencode/events.js"
import { BindingStore } from "./storage/bindings.js"
import { FeishuBot } from "./feishu/bot.js"
import { ConversationService } from "./core/conversations.js"
import { InteractionService } from "./core/interactions.js"
import { CronManager } from "./scheduler/cron.js"
import { HealthMonitor } from "./monitor/health.js"

/**
 * Wires all subsystems together and owns their lifecycle.
 */
export class App {
  private readonly logger: Logger
  private readonly audit: AuditLog
  private readonly storageDir: string
  private readonly service: OpencodeService
  private readonly eventBus: OpencodeEventBus
  private readonly bindings: BindingStore
  private readonly bots = new Map<string, FeishuBot>()
  private readonly conversations: ConversationService
  private readonly interactions: InteractionService
  private readonly cron: CronManager
  private readonly health: HealthMonitor
  private started = false

  constructor(private readonly loaded: LoadedConfig) {
    const { config } = loaded
    this.storageDir = config.storageDir
    const logDir = ensureDir(path.join(this.storageDir, "logs"))
    this.logger = new Logger({ level: config.logLevel, dir: logDir, pretty: true, name: "bridge" })
    this.audit = new AuditLog(logDir)

    this.service = new OpencodeService(config.opencode, this.logger.child("opencode"))
    this.eventBus = new OpencodeEventBus(this.service, this.logger.child("events"))
    this.bindings = new BindingStore(this.storageDir)

    this.conversations = new ConversationService({
      config,
      logger: this.logger.child("conversation"),
      audit: this.audit,
      opencode: this.service,
      events: this.eventBus,
      bindings: this.bindings,
      bots: this.bots,
    })

    this.interactions = new InteractionService({
      logger: this.logger.child("interaction"),
      audit: this.audit,
      getClient: () => this.service.client(),
      getBot: (name) => this.bots.get(name),
      getContext: (sessionID) => this.conversations.getContext(sessionID),
      activeSessions: () => this.conversations.activeSessions(),
    })

    this.cron = new CronManager({
      config,
      conversations: this.conversations,
      logger: this.logger.child("cron"),
      audit: this.audit,
      storageDir: this.storageDir,
    })

    this.health = new HealthMonitor({
      config: config.opencode,
      service: this.service,
      logger: this.logger.child("health"),
      audit: this.audit,
      alert: (message) => this.broadcastAlert(message),
    })

    this.conversations.commandHandler.setFormAnswerHandler(this.interactions)
    this.conversations.commandHandler.setCronController(this.cron)
    this.conversations.setInteractionProbe((sessionID) => this.interactions.hasPending(sessionID))

    for (const botConfig of config.bots) {
      const bot: FeishuBot = new FeishuBot(botConfig, this.logger, {
        onMessage: (message) => this.conversations.handleMessage(bot, message),
        onCardAction: (event) => this.interactions.handleCardAction(bot, event),
        onReject: (event) => this.logger.debug("Message rejected by policy", { reason: event.reason, chatId: event.chatId }),
        onError: (error) => this.logger.error("Bot error", { error: error.message }),
      })
      this.bots.set(botConfig.name, bot)
    }

    for (const botConfig of config.bots) {
      const sessionRoot = botConfig.location ?? config.opencode.location
      this.logger.info("Bot storage resolved", {
        bot: botConfig.name,
        sessionRoot,
        project: botConfig.project ?? sessionRoot,
        agent: botConfig.agent,
      })
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.logger.info("Starting feishu-bridge", { bots: [...this.bots.keys()] })

    // Verify the OpenCode connection up front so failures surface early.
    const health = await this.service.health()
    if (health.ok) this.logger.info("OpenCode ready", { version: health.info?.version })
    else this.logger.warn("OpenCode not reachable yet; will keep retrying", { error: health.error })

    this.eventBus.start()
    this.interactions.start()
    this.cron.start()
    this.health.start()

    for (const bot of this.bots.values()) {
      try {
        await bot.connect()
      } catch (error) {
        this.logger.error("Failed to connect bot", {
          bot: bot.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    // Catch answers whose turn already closed (timeout / restart) and push them
    // to the chat so the Feishu side always catches up with OpenCode.
    this.conversations.startRecovery()
    this.logger.info("feishu-bridge is running")
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping feishu-bridge")
    this.health.stop()
    this.cron.stop()
    this.conversations.stopRecovery()
    this.interactions.stop()
    this.eventBus.stop()
    for (const bot of this.bots.values()) {
      await bot.disconnect().catch(() => {})
    }
    this.bindings.flush()
  }

  private async broadcastAlert(message: string): Promise<void> {
    for (const bot of this.bots.values()) {
      const chatId = bot.config.access.alertChatId
      if (!chatId) continue
      await bot.sendMarkdown(chatId, message).catch(() => {})
    }
  }
}
