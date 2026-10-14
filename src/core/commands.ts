import fs from "node:fs"
import path from "node:path"
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk"
import type { ConversationService, ChatIdentity } from "./conversations.js"
import type { FeishuBot } from "../feishu/bot.js"
import { helpCard, markdownCard, statusCard } from "../feishu/cards.js"
import { ensureDir } from "../util/paths.js"

export interface FormAnswerHandler {
  /** Handle `/answer` text for a session. Returns a human readable status. */
  answer(sessionID: string, args: string): Promise<string>
}

export interface CronController {
  describe(): string
  add(args: string[], identity: ChatIdentity, botName: string): Promise<string>
  remove(name: string): Promise<string>
  run(name: string): Promise<string>
}

/**
 * Slash-command router. Keeps the conversation service focused on prompts while
 * exposing management operations to chat users.
 */
export class CommandHandler {
  private formAnswer?: FormAnswerHandler
  private cron?: CronController

  constructor(private readonly conversations: ConversationService) {}

  setFormAnswerHandler(handler: FormAnswerHandler): void {
    this.formAnswer = handler
  }

  setCronController(controller: CronController): void {
    this.cron = controller
  }

  /** Returns true when the message was a command that has been handled. */
  async handle(bot: FeishuBot, identity: ChatIdentity, msg: NormalizedMessage, text: string): Promise<boolean> {
    const [rawCommand, ...rest] = text.slice(1).trim().split(/\s+/)
    const command = (rawCommand ?? "").toLowerCase()
    const args = rest.join(" ")
    const binding = await this.conversations.ensureSession(bot, identity, identity.chatId)
    switch (command) {
      case "help":
      case "":
        await bot.sendCard(identity.chatId, helpCard(), { replyTo: msg.messageId })
        return true
      case "whoami":
        await bot.sendCard(
          identity.chatId,
          statusCard("🪪 当前绑定", [
            `**Bot：** ${bot.name}`,
            `**会话目录：** \`${binding.directory}\``,
            `**Session：** \`${binding.sessionID}\``,
            `**Agent：** \`${binding.agent}\``,
            binding.model ? `**模型：** \`${binding.model.providerID}/${binding.model.id}\`` : "",
          ].filter(Boolean).join("\n")),
          { replyTo: msg.messageId },
        )
        return true
      case "new":
      case "reset": {
        const fresh = await this.conversations.resetSession(bot, identity)
        await bot.sendCard(
          identity.chatId,
          statusCard("🆕 新会话已创建", `Session：\`${fresh.sessionID}\`\n目录：\`${fresh.directory}\``, "green"),
          { replyTo: msg.messageId },
        )
        return true
      }
      case "sessions": {
        const mine = this.conversations.bindings.all().filter((b) => b.bot === bot.name)
        const content = mine.length
          ? mine
              .map((b) => `- \`${b.sessionID}\` · ${b.chatType === "p2p" ? "私聊" : "群聊"} ${b.chatId}`)
              .join("\n")
          : "当前没有已绑定的会话。"
        await bot.sendCard(identity.chatId, markdownCard("📂 会话列表", content), { replyTo: msg.messageId })
        return true
      }
      case "agent": {
        if (!args) {
          await bot.sendText(identity.chatId, "用法：/agent <名称>，如 /agent build", { replyTo: msg.messageId })
          return true
        }
        const client = await this.conversations.opencode.client()
        await client.switchAgent(binding.sessionID, args.trim())
        binding.agent = args.trim()
        this.conversations.bindings.set(binding)
        await bot.sendText(identity.chatId, `已切换 Agent 为 ${args.trim()}`, { replyTo: msg.messageId })
        return true
      }
      case "model": {
        if (!args) {
          await bot.sendText(identity.chatId, "用法：/model providerID/modelID", { replyTo: msg.messageId })
          return true
        }
        const model = parseModel(args.trim())
        if (!model) {
          await bot.sendText(identity.chatId, "无法解析模型，请使用 providerID/modelID 格式", { replyTo: msg.messageId })
          return true
        }
        const client = await this.conversations.opencode.client()
        await client.switchModel(binding.sessionID, model)
        binding.model = model
        this.conversations.bindings.set(binding)
        await bot.sendText(identity.chatId, `已切换模型为 ${model.providerID}/${model.id}`, { replyTo: msg.messageId })
        return true
      }
      case "stop": {
        const client = await this.conversations.opencode.client()
        await client.interrupt(binding.sessionID)
        await bot.sendText(identity.chatId, "已请求中断当前执行。", { replyTo: msg.messageId })
        return true
      }
      case "export": {
        const client = await this.conversations.opencode.client()
        const data = await client.exportSession(binding.sessionID)
        ensureDir(binding.directory)
        const file = path.join(binding.directory, `export-${binding.sessionID}.json`)
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
        await bot.sendFile(identity.chatId, file, path.basename(file), { replyTo: msg.messageId })
        return true
      }
      case "import": {
        const resource = msg.resources.find((r) => r.type === "file")
        if (!resource) {
          await bot.sendText(identity.chatId, "请把导出的 JSON 文件作为附件随 /import 一起发送。", { replyTo: msg.messageId })
          return true
        }
        const buffer = await bot.downloadMessageResource(msg.messageId, resource.fileKey, "file")
        const parsed = JSON.parse(buffer.toString("utf8")) as { info: unknown; messages: unknown[] }
        const client = await this.conversations.opencode.client()
        const session = await client.importSession(parsed as never)
        binding.sessionID = session.id
        this.conversations.bindings.set(binding)
        await bot.sendCard(
          identity.chatId,
          statusCard("📥 会话已导入", `Session：\`${session.id}\``, "green"),
          { replyTo: msg.messageId },
        )
        return true
      }
      case "answer": {
        if (!this.formAnswer) {
          await bot.sendText(identity.chatId, "当前没有待回答的问题。", { replyTo: msg.messageId })
          return true
        }
        const status = await this.formAnswer.answer(binding.sessionID, args)
        await bot.sendText(identity.chatId, status, { replyTo: msg.messageId })
        return true
      }
      case "cron": {
        if (!this.cron) {
          await bot.sendText(identity.chatId, "定时任务未启用。", { replyTo: msg.messageId })
          return true
        }
        const sub = rest[0]?.toLowerCase()
        const subArgs = rest.slice(1)
        let result: string
        if (!sub || sub === "list") result = this.cron.describe()
        else if (sub === "add") result = await this.cron.add(subArgs, identity, bot.name)
        else if (sub === "remove" || sub === "rm") result = await this.cron.remove(subArgs[0] ?? "")
        else if (sub === "run") result = await this.cron.run(subArgs[0] ?? "")
        else result = "用法：/cron list | add <名称> <cron表达式> <提示词> | remove <名称> | run <名称>"
        await bot.sendCard(identity.chatId, markdownCard("⏰ 定时任务", result), { replyTo: msg.messageId })
        return true
      }
      default:
        return false
    }
  }
}

function parseModel(input: string): { providerID: string; id: string } | undefined {
  const separator = input.includes("/") ? "/" : input.includes(":") ? ":" : undefined
  if (!separator) return undefined
  const [providerID, id] = input.split(separator)
  if (!providerID || !id) return undefined
  return { providerID, id }
}
