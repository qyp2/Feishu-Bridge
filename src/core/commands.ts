import fs from "node:fs"
import path from "node:path"
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk"
import type { ConversationService, ChatIdentity } from "./conversations.js"
import { mentionsFor, type FeishuBot } from "../feishu/bot.js"
import { CONFIG_CHANGE_DENIED, isConfigCommand } from "./configGuard.js"
import { cronManageCard, escapeMarkdown, helpCard, isMailJob, loginCard, mailSubscribeCard, makeFormCard, makePosterCard, markdownCard, skillDeleteConfirmCard, skillFormCard, skillManageCard, skillSavedCard, statusCard, studioCard, studioKindFrom, subscribeCard } from "../feishu/cards.js"
import { describeSkill } from "../skills/store.js"
import { ensureDir } from "../util/paths.js"
import { writeMailScope, type MailBindingStore } from "../mail/binding.js"

export interface FormAnswerHandler {
  /** Handle `/answer` text for a session. Returns a human readable status. */
  answer(sessionID: string, args: string, operatorOpenId?: string): Promise<string>
}

const OPEN_API = "https://open.feishu.cn/open-apis"

/**
 * 查操作者在飞书通讯录里登记的企业邮箱（tenant token + contact:user.email:readonly）。
 * 邮箱绑定只认这个地址——用户在聊天里自报的地址必须和它一致，否则拒绝。
 */
export async function lookupUserEmail(bot: FeishuBot, openId: string): Promise<string> {
  const tokenResp = await fetch(`${OPEN_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: bot.config.appId, app_secret: bot.config.appSecret }),
  })
  const tokenData = (await tokenResp.json()) as { code: number; tenant_access_token?: string }
  if (tokenData.code !== 0 || !tokenData.tenant_access_token) return ""
  const resp = await fetch(`${OPEN_API}/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`, {
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
  })
  const data = (await resp.json()) as { code: number; data?: { user?: { email?: string } } }
  if (data.code !== 0) return ""
  return (data.data?.user?.email ?? "").trim()
}

/**
 * 邮件日报的固定 prompt：表单只收集频率和时间，用户不再填写管理要求。
 * 总结范围随频率（每天→1 天，每周→7 天，每月→30 天），格式固定为：
 * 总体一句概括 → 着重列「需要尽快回复」和「截止日期临近」→ 只读声明收尾。
 */
export function buildMailDigestPrompt(days: number, email: string): string {
  return (
    `用 S64 邮件查收技能总结邮箱 ${email} 最近 ${days} 天的收件箱并推送日报。只读当前会话已经绑定的这个邮箱，不要更换邮箱，也不要读取其他人的邮件。\n` +
    "1. 先 list --size 20 拉列表，对「可能需要尽快回复」或「可能含截止日期」的邮件再 get 读正文确认（接口不返回发件人字段，从正文引用头/签名推断）。\n" +
    "2. 严格按下面的固定格式输出，不要增删板块：\n" +
    `   开头一句：看完了 ${email} 最近 ${days} 天的邮件，{一句概括总体构成，如：主要是推广和自动通知}。\n` +
    "   【需要尽快回复】逐封列：主题 — 发件人：一句摘要。判断标准：直接发给本人且需要尽快响应——关键客户/合作伙伴来函、领导交办、合同/付款/报价、截止催促、投诉或故障。一封都没有就直说「暂时没发现需要尽快回复的邮件」。\n" +
    "   【截止日期临近】未来两周内有明确截止日期、需要我处理的事项，逐条列：事项 — 截止日期（注明来自哪封邮件）。没有就直说「没发现未来两周有明确截止日期、需要我处理的事项」。\n" +
    "   含重要附件的邮件点名一句存在（如「富途的开户文件邮件还在，附件我没有打开」）；没有其他值得点名的就整段省略。\n" +
    "   结尾固定一句：所有邮件保持原样，没有标记已读、发送、删除或修改。\n" +
    "3. 范围内一封邮件都没有：直说没有邮件，结尾那句照常附上。"
  )
}

export interface CronJobInfo {
  name: string
  schedule: string
  prompt: string
  enabled: boolean
  urgent: boolean
  next?: string
  chatId: string
  ownerOpenId?: string
}

export interface CronController {
  describe(): string
  list(): CronJobInfo[]
  /** Jobs this person may see and change: their own, plus legacy jobs that belong to this chat and have no owner. */
  listFor(openId: string, chatId: string): CronJobInfo[]
  add(args: string[], identity: ChatIdentity, botName: string): Promise<string>
  remove(name: string): Promise<string>
  run(name: string): Promise<string>
  togglePause(name: string): boolean | undefined
  toggleUrgent(name: string): boolean | undefined
}

/**
 * Slash-command router. Keeps the conversation service focused on prompts while
 * exposing management operations to chat users.
 */
export class CommandHandler {
  private formAnswer?: FormAnswerHandler
  private cron?: CronController
  private mailBinding?: MailBindingStore

  constructor(private readonly conversations: ConversationService) {}

  setFormAnswerHandler(handler: FormAnswerHandler): void {
    this.formAnswer = handler
  }

  setCronController(controller: CronController): void {
    this.cron = controller
  }

  setMailBindingStore(store: MailBindingStore): void {
    this.mailBinding = store
  }

  /** Returns true when the message was a command that has been handled. */
  async handle(bot: FeishuBot, identity: ChatIdentity, msg: NormalizedMessage, text: string): Promise<boolean> {
    const [rawCommand, ...rest] = text.slice(1).trim().split(/\s+/)
    const command = (rawCommand ?? "").toLowerCase()
    const args = rest.join(" ")
    if (identity.chatType === "group" && isConfigCommand(command)) {
      await bot.sendText(identity.chatId, CONFIG_CHANGE_DENIED, {
        replyTo: msg.messageId,
        mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName),
      })
      return true
    }
    const binding = await this.conversations.ensureSession(bot, identity, identity.chatId)
    switch (command) {
      case "help":
      case "":
        await bot.sendCard(identity.chatId, helpCard(), { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      case "mail": {
        const bind = /^bind(?:\s+(\S+))?$/i.exec(args.trim())
        if (!bind) {
          await bot.sendText(identity.chatId, "用法：发送「绑定邮箱」，自动绑定你飞书账号登记的邮箱。", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
          return true
        }
        await this.bindMailbox(bot, identity, msg, binding.directory, bind[1])
        return true
      }
      case "whoami":
        await bot.sendCard(
          identity.chatId,
          statusCard("🪪 当前绑定", [
            `**Bot：** ${bot.name}`,
            `**会话目录：** \`${binding.directory}\``,
            `**Session：** \`${binding.sessionID}\``,
            `**Agent：** \`${binding.agent}\``,
            binding.model ? `**模型：** \`${binding.model.providerID}/${binding.model.id}\`` : "",
            `**我的 OpenID：** \`${identity.senderId}\``,
            this.conversations.isSkillAdmin(identity.senderId) ? "**技能管理员：** 是" : "",
          ].filter(Boolean).join("\n")),
          { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) },
        )
        return true
      case "new":
      case "reset": {
        await this.conversations.resetSession(bot, identity)
        await bot.sendCard(
          identity.chatId,
          statusCard("已开启新对话", "已开启新对话", "green"),
          { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) },
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
        await bot.sendCard(identity.chatId, markdownCard("📂 会话列表", content), { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      }
      case "agent": {
        if (!args) {
          await bot.sendText(identity.chatId, "用法：/agent <名称>，如 /agent build", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
          return true
        }
        const client = await this.conversations.opencode.client()
        await client.switchAgent(binding.sessionID, args.trim())
        binding.agent = args.trim()
        this.conversations.bindings.set(binding)
        await bot.sendText(identity.chatId, `已切换 Agent 为 ${args.trim()}`, { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      }
      case "model": {
        if (!args) {
          await bot.sendText(identity.chatId, "用法：/model providerID/modelID", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
          return true
        }
        const model = parseModel(args.trim())
        if (!model) {
          await bot.sendText(identity.chatId, "无法解析模型，请使用 providerID/modelID 格式", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
          return true
        }
        const client = await this.conversations.opencode.client()
        await client.switchModel(binding.sessionID, model)
        binding.model = model
        this.conversations.bindings.set(binding)
        await bot.sendText(identity.chatId, `已切换模型为 ${model.providerID}/${model.id}`, { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      }
      case "studio": {
        if (identity.chatType === "group") {
          await bot.sendText(identity.chatId, "创作工作台请在和机器人的私聊里打开。", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
          return true
        }
        const kind = studioKindFrom(args.trim())
        await bot.sendCard(identity.chatId, studioCard({ kind }), { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      }
      case "login": {
        if (identity.chatType === "group") {
          await bot.sendText(identity.chatId, "验证码登录请在和机器人的私聊里打开。", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
          return true
        }
        await bot.sendCard(identity.chatId, loginCard(), { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      }
      case "make": {
        const sub = (rest[0] ?? "").toLowerCase()
        if (sub === "doc") {
          await bot.sendCard(
            identity.chatId,
            markdownCard(
              "🛠️ 文档制作",
              "请从菜单「制作 > 文档制作」下直接选择:**PPT 生成** / **PDF 生成** / **Word 生成**,会打开对应的制作表单。\n也可以直接发文字,如「PPT 生成」。",
            ),
            { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) },
          )
          return true
        }
        if (sub === "poster") {
          await bot.sendCard(identity.chatId, makePosterCard(), { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
          return true
        }
        const format =
          sub === "ppt" ? "pptx" : sub === "word" ? "docx" : sub === "pdf" ? "pdf" : sub === "excel" ? "xlsx" : sub === "copy" ? "copy" : undefined
        if (!format) {
          await bot.sendText(identity.chatId, "用法:/make doc|ppt|word|pdf|excel|copy|poster", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
          return true
        }
        const data = this.conversations.makeFormData(identity.chatId, identity.senderId, format)
        const nonce = this.conversations.issueMakeForm(identity.chatId, identity.senderId)
        await bot.sendCard(identity.chatId, makeFormCard(data, undefined, nonce), { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      }
      case "templates": {
        const { shared, personal } = this.conversations.listTemplates(identity.senderId)
        const section = (title: string, names: string[]) =>
          `**${title}**\n${names.length ? names.map((name) => `- **${name}**`).join("\n") : "- 暂无"}`
        const sample = personal[0] ?? shared[0]
        const usage = sample
          ? `用法：消息里说「用${sample}模板」即可套用（同名时优先你的个人模板）；发一个 .pptx 并写「存为模板 名字」存个人模板，管理员写「存为共享模板 名字」存共享模板。`
          : "还没有保存的模板。发一个 .pptx 文件并写「存为模板 名字」即可保存个人模板。"
        const content = `${section("共享模板（全员可用）", shared)}\n\n${section("我的模板", personal)}\n\n${usage}`
        await bot.sendCard(identity.chatId, markdownCard("🧩 模板库", content), { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      }
      case "skills": {
        await bot.sendCard(
          identity.chatId,
          skillManageCard(this.conversations.skills.list(identity.senderId), this.conversations.isSkillAdmin(identity.senderId)),
          { replyTo: msg.messageId },
        )
        return true
      }
      case "skill": {
        const store = this.conversations.skills
        const isAdmin = this.conversations.isSkillAdmin(identity.senderId)
        const sub = (rest[0] ?? "").toLowerCase()
        if (!sub || sub === "new" || sub === "add" || sub === "create") {
          await bot.sendCard(identity.chatId, skillFormCard({}, { isAdmin }), { replyTo: msg.messageId })
          return true
        }
        if (sub === "list" || sub === "ls") {
          await bot.sendCard(identity.chatId, skillManageCard(store.list(identity.senderId), isAdmin), {
            replyTo: msg.messageId,
          })
          return true
        }
        const target = rest.slice(1).join(" ").trim()
        const skill = target ? store.get(identity.senderId, target) : undefined
        if (!skill) {
          await bot.sendText(
            identity.chatId,
            target
              ? `没有找到技能「${target}」。发「技能」看看你现有的技能。`
              : "用法：/skill new | list | show <名称> | use <名称> | del <名称>",
            { replyTo: msg.messageId },
          )
          return true
        }
        if (sub === "use" || sub === "try" || sub === "run") {
          await this.conversations.runSkillTrial(bot, identity, skill, msg.messageId)
          return true
        }
        if (sub === "show" || sub === "view") {
          await bot.sendCard(
            identity.chatId,
            markdownCard(`🧩 ${skill.name}`, `${describeSkill(skill)}\n\n**执行步骤与要求**\n${skill.steps}${skill.output ? `\n\n**输出要求**\n${skill.output}` : ""}`),
            { replyTo: msg.messageId },
          )
          return true
        }
        if (sub === "del" || sub === "delete" || sub === "remove" || sub === "rm") {
          if (skill.scope === "shared" && !isAdmin) {
            await bot.sendText(identity.chatId, "共享技能只有管理员能删。", { replyTo: msg.messageId })
            return true
          }
          await bot.sendCard(identity.chatId, skillDeleteConfirmCard(skill), { replyTo: msg.messageId })
          return true
        }
        if (sub === "share") {
          if (!isAdmin) {
            await bot.sendText(identity.chatId, "共享给全员只有管理员可以操作。", { replyTo: msg.messageId })
            return true
          }
          try {
            const shared = store.save(
              identity.senderId,
              {
                id: skill.id,
                name: skill.name,
                triggers: skill.triggers,
                scene: skill.scene,
                steps: skill.steps,
                output: skill.output,
                scope: "shared",
              },
              { allowShared: true, ownerName: identity.senderName },
            )
            await bot.sendCard(identity.chatId, skillSavedCard(shared, isAdmin), { replyTo: msg.messageId })
          } catch (error) {
            await bot.sendText(identity.chatId, error instanceof Error ? error.message : String(error), {
              replyTo: msg.messageId,
            })
          }
          return true
        }
        await bot.sendText(identity.chatId, "用法：/skill new | list | show <名称> | use <名称> | del <名称>", {
          replyTo: msg.messageId,
        })
        return true
      }
      case "stop": {
        const client = await this.conversations.opencode.client()
        await client.interrupt(binding.sessionID)
        await bot.sendText(identity.chatId, "已请求中断当前执行。", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      }
      case "export": {
        const client = await this.conversations.opencode.client()
        const data = await client.exportSession(binding.sessionID)
        ensureDir(binding.directory)
        const file = path.join(binding.directory, `export-${binding.sessionID}.json`)
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
        await bot.sendFile(identity.chatId, file, path.basename(file), { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
        return true
      }
      case "import": {
        const resource = msg.resources.find((r) => r.type === "file")
        if (!resource) {
          await bot.sendText(identity.chatId, "请把导出的 JSON 文件作为附件随 /import 一起发送。", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
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
          { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) },
        )
        return true
      }
      case "answer": {
        if (!this.formAnswer) {
          await bot.sendText(identity.chatId, "当前没有待回答的问题。", { replyTo: msg.messageId, mentions: mentionsFor(identity.chatType, identity.senderId, identity.senderName) })
          return true
        }
        const status = await this.formAnswer.answer(binding.sessionID, args, identity.senderId)
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
        if (sub === "form") {
          // 「资讯订阅」：弹出点选式订阅表单卡片，提交走 card callback（cron-sub）。
          await bot.sendCard(identity.chatId, subscribeCard(), { replyTo: msg.messageId })
          return true
        }
        if (sub === "mail") {
          const mine = this.cron.listFor(identity.senderId, identity.chatId).find((job) => isMailJob(job))
          const bound = Boolean(this.mailBinding?.get(identity.senderId)?.email)
          await bot.sendCard(
            identity.chatId,
            mailSubscribeCard(mine && bound ? { name: mine.name, schedule: mine.schedule } : undefined),
            { replyTo: msg.messageId },
          )
          return true
        }
        if (sub === "manage") {
          await bot.sendCard(identity.chatId, cronManageCard(this.cron.listFor(identity.senderId, identity.chatId)), { replyTo: msg.messageId })
          return true
        }
        const mine = () => this.cron!.listFor(identity.senderId, identity.chatId)
        let result: string
        if (!sub || sub === "list") {
          const jobs = mine()
          result = jobs.length
            ? jobs.map((job) => `- **${job.name}** \`${job.schedule}\`${job.enabled ? "" : "（已暂停）"}`).join("\n")
            : "暂无订阅。\n点击下方菜单「订阅 > 资讯订阅」或「订阅 > 邮件订阅」即可创建。"
        } else if (sub === "add") result = await this.cron.add(subArgs, identity, bot.name)
        else if ((sub === "remove" || sub === "rm" || sub === "run") && !mine().some((job) => job.name === (subArgs[0] ?? ""))) {
          result = `未找到定时任务：${subArgs[0] ?? ""}`
        } else if (sub === "remove" || sub === "rm") result = await this.cron.remove(subArgs[0] ?? "")
        else if (sub === "run") result = await this.cron.run(subArgs[0] ?? "")
        else result = "用法：/cron list | add <名称> <cron表达式> <提示词> | remove <名称> | run <名称>"
        await bot.sendCard(identity.chatId, markdownCard("⏰ 定时任务", result), { replyTo: msg.messageId })
        return true
      }
      default:
        return false
    }
  }

  /**
   * 绑定邮箱：只认操作者在飞书通讯录登记的企业邮箱。用户自报地址必须和它
   * 一致，否则拒绝——这样「输入别人的邮箱号就能读别人邮件」不成立（再叠加
   * 飞书后台数据权限只放行已登记邮箱的第二道防线）。
   */
  private async bindMailbox(bot: FeishuBot, identity: ChatIdentity, msg: NormalizedMessage, directory: string, claimed?: string): Promise<void> {
    if (!this.mailBinding) {
      await bot.sendText(identity.chatId, "邮箱绑定服务未启用，请联系管理员。", { replyTo: msg.messageId })
      return
    }
    const actual = await lookupUserEmail(bot, identity.senderId).catch(() => "")
    if (!actual) {
      await bot.sendText(
        identity.chatId,
        "没能从飞书通讯录查到你的企业邮箱（账号未登记邮箱，或应用缺少通讯录读取权限）。请联系管理员核对后再试。",
        { replyTo: msg.messageId },
      )
      return
    }
    if (claimed && claimed.toLowerCase() !== actual.toLowerCase()) {
      await bot.sendCard(
        identity.chatId,
        markdownCard(
          "❌ 绑定被拒绝",
          `你填写的 **${escapeMarkdown(claimed)}** 与你飞书账号登记的邮箱不一致（你的登记邮箱是 **${escapeMarkdown(actual)}**）。\n只能绑定你自己的邮箱。`,
        ),
        { replyTo: msg.messageId },
      )
      return
    }
    if (this.mailBinding.takenByOther(actual, identity.senderId)) {
      await bot.sendCard(
        identity.chatId,
        markdownCard("❌ 绑定被拒绝", "这个邮箱已经绑定在另一个飞书账号上，不能重复绑定。"),
        { replyTo: msg.messageId },
      )
      return
    }
    const saved = this.mailBinding.set(identity.senderId, actual, { chatId: identity.chatId, bot: bot.name })
    writeMailScope(directory, saved.scope)
    await bot.sendCard(
      identity.chatId,
      statusCard(
        "📮 邮箱已绑定",
        `已绑定你飞书账号登记的邮箱：**${escapeMarkdown(actual)}**\n之后的邮件日报和重要邮件只读这个邮箱。`,
        "green",
      ),
      { replyTo: msg.messageId },
    )
  }
}

function parseModel(input: string): { providerID: string; id: string } | undefined {
  const separator = input.includes("/") ? "/" : input.includes(":") ? ":" : undefined
  if (!separator) return undefined
  const [providerID, id] = input.split(separator)
  if (!providerID || !id) return undefined
  return { providerID, id }
}
