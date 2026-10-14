import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { resolveFrom } from "../util/paths.js"

const ModelRefSchema = z.object({
  providerID: z.string(),
  id: z.string(),
  variant: z.string().optional(),
})

const OpenCodeSchema = z.object({
  /** "service" discovers/starts the shared background service; "remote" uses baseUrl. */
  mode: z.enum(["service", "remote"]).default("service"),
  baseUrl: z.string().default("http://127.0.0.1:4096"),
  /** Password for the shared service. Leave empty to read from the service registration file. */
  password: z.string().default(""),
  /** Default working directory used when a bot has no explicit location. */
  location: z.string().default(process.cwd()),
  /**
   * Root directory for a dedicated, isolated OpenCode service. When set, the
   * bridge starts its own service so this bridge's sessions and database live
   * under this directory instead of the machine-wide OpenCode data directory.
   * The global provider/model config (XDG_CONFIG_HOME) is intentionally shared.
   */
  dataDir: z.string().optional(),
  /** Port for the isolated service; 0 lets the OS pick a free port. */
  servicePort: z.number().int().min(0).max(65535).default(0),
  /** Extra environment variables passed to the spawned service (e.g. API keys). */
  env: z.record(z.string()).optional(),
  /** Command used to (re)start the service in "service" mode. */
  serviceCommand: z.array(z.string()).default(["opencode", "serve", "--service"]),
  /** Command used to restart the shared service on failure. */
  restartCommand: z.array(z.string()).default(["opencode", "service", "restart"]),
  healthIntervalMs: z.number().int().positive().default(30_000),
  healthTimeoutMs: z.number().int().positive().default(8_000),
  restartOnFailure: z.boolean().default(true),
  /** Consecutive failed health checks before a restart is attempted. */
  failureThreshold: z.number().int().positive().default(3),
})

const AccessSchema = z.object({
  /** Allow list of chat ids. Empty means all chats are allowed. */
  allowChats: z.array(z.string()).default([]),
  /** Allow list of user open_ids. Empty means all users are allowed. */
  allowUsers: z.array(z.string()).default([]),
  /** Open id / chat id that receives monitor alerts. */
  alertChatId: z.string().optional(),
})

const StreamingSchema = z.object({
  /** cardkit: typewriter card; patch: full card replacement updates. */
  strategy: z.enum(["cardkit", "patch"]).default("cardkit"),
  /** Minimum interval between card updates. */
  intervalMs: z.number().int().positive().default(700),
  /** Show reasoning (thinking) content in the card footer. */
  showReasoning: z.boolean().default(false),
  /** Show a compact tool activity line inside the card. */
  showTools: z.boolean().default(true),
})

const BotSchema = z.object({
  name: z.string(),
  appId: z.string(),
  appSecret: z.string(),
  domain: z.enum(["feishu", "lark"]).default("feishu"),
  /** Agent id used for new sessions created by this bot. */
  agent: z.string().default("build"),
  model: ModelRefSchema.optional(),
  /** Working directory root for this bot's sessions. */
  location: z.string().optional(),
  /**
   * OpenCode project directory that provides the agents/skills/commands
   * (`.opencode` + opencode config). When set, and when `location` differs, the
   * bridge mirrors that project into `location` so sessions stored there still
   * resolve the project's agents. Use this to keep `location` under storageDir.
   */
  project: z.string().optional(),
  /** When true each user in a group gets an isolated session + folder. */
  perUserInGroup: z.boolean().default(false),
  streaming: StreamingSchema.default({}),
  access: AccessSchema.default({}),
  commands: z.boolean().default(true),
  /**
   * When a user sends a file/image without any text, hold it and ask what to do
   * instead of immediately prompting the agent. The files are attached to the
   * next instruction. Set false to auto-prompt with a generic message.
   */
  holdAttachmentsWithoutText: z.boolean().default(true),
  /** Require an @mention before the bot replies in group chats. */
  requireMention: z.boolean().default(true),
})

const CronJobSchema = z.object({
  name: z.string(),
  bot: z.string(),
  schedule: z.string(),
  chatId: z.string(),
  prompt: z.string(),
  /** Optional user id used for the isolated folder when perUserInGroup is on. */
  userId: z.string().optional(),
  enabled: z.boolean().default(true),
})

const ConfigSchema = z.object({
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  storageDir: z.string().default("./data"),
  opencode: OpenCodeSchema.default({}),
  bots: z.array(BotSchema).min(1),
  cron: z.array(CronJobSchema).default([]),
})

export type ModelRef = z.infer<typeof ModelRefSchema>
export type OpenCodeConfig = z.infer<typeof OpenCodeSchema>
export type BotConfig = z.infer<typeof BotSchema>
export type CronJobConfig = z.infer<typeof CronJobSchema>
export type AccessConfig = z.infer<typeof AccessSchema>
export type StreamingConfig = z.infer<typeof StreamingSchema>
export type AppConfig = z.infer<typeof ConfigSchema>

export interface LoadedConfig {
  config: AppConfig
  baseDir: string
  file?: string
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  const file = explicitPath ?? process.env.FEISHU_BRIDGE_CONFIG ?? path.join("config", "config.json")
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) {
    throw new Error(
      `Config file not found: ${abs}\nCopy config/config.example.json to config/config.json and fill in your bot credentials.`,
    )
  }
  const baseDir = path.dirname(abs)
  const parsed = JSON.parse(fs.readFileSync(abs, "utf8"))
  // Environment overrides for secrets so they do not have to live in the file.
  if (process.env.OPENCODE_PASSWORD) parsed.opencode = { ...parsed.opencode, password: process.env.OPENCODE_PASSWORD }
  if (process.env.OPENCODE_BASE_URL) parsed.opencode = { ...parsed.opencode, baseUrl: process.env.OPENCODE_BASE_URL }
  for (const bot of parsed.bots ?? []) {
    const prefix = `BOT_${String(bot.name).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`
    if (process.env[prefix + "APP_ID"]) bot.appId = process.env[prefix + "APP_ID"]
    if (process.env[prefix + "APP_SECRET"]) bot.appSecret = process.env[prefix + "APP_SECRET"]
  }
  const config = ConfigSchema.parse(parsed)
  // Resolve storage relative to the config file so cwd does not matter.
  config.storageDir = resolveFrom(baseDir, config.storageDir)
  if (config.opencode.dataDir) config.opencode.dataDir = resolveFrom(baseDir, config.opencode.dataDir)
  for (const bot of config.bots) {
    if (bot.location) bot.location = resolveFrom(baseDir, bot.location)
    if (bot.project) bot.project = resolveFrom(baseDir, bot.project)
  }
  return { config, baseDir, file: abs }
}
