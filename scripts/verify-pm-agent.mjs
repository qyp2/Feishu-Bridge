/**
 * 端到端验证：桥接 → OpenCode → PM-Agent（pm-brain 路由 → 子 Agent）
 *
 * 复刻 conversations.ts 的会话建立路径：
 *   1. 在 <bot.location>/<bot.name>/ 下建立指向 PM-Agent/.opencode 的链接并复制 opencode.jsonc
 *   2. 在会话目录里建 session，agent = pm-brain
 *   3. 校验 pm-brain 及 pm-a* 子 Agent 都能被发现
 *   4. 发一条会命中路由表的任务，检查 A0 是否真的派发了对应子 Agent
 *
 * 用法：node scripts/verify-pm-agent.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../dist/config/index.js"
import { OpencodeService } from "../dist/opencode/service.js"
import { Logger } from "../dist/util/logger.js"
import { ensureDir, ensureProjectLink } from "../dist/util/paths.js"

const here = path.dirname(fileURLToPath(import.meta.url))
process.chdir(path.resolve(here, ".."))

const { config } = loadConfig()
const bot = config.bots[0]
const logger = new Logger({ level: "warn", pretty: true, name: "verify" })

function ok(label, detail = "") {
  console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`)
}
function fail(label, detail = "") {
  console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`)
  process.exitCode = 1
}

// ---- 1. 项目镜像（与 ensureBotProject 一致） ----
const botDir = path.join(bot.location, bot.name)
ensureDir(botDir)
ensureProjectLink(botDir, bot.project)

const link = path.join(botDir, ".opencode")
const cfgCopy = path.join(botDir, "opencode.jsonc")
if (fs.existsSync(link)) ok(".opencode 链接已建立", fs.readlinkSync(link))
else fail(".opencode 链接缺失", link)
if (fs.existsSync(cfgCopy)) ok("opencode.jsonc 已复制", cfgCopy)
else fail("opencode.jsonc 未复制", cfgCopy)

// ---- 2. 连接隔离服务 ----
const service = new OpencodeService(config.opencode, logger)
const client = await service.client()
const info = await client.info()
console.log(`\nOpenCode ${info.version} @ ${client.baseUrl} (isolated=${Boolean(config.opencode.dataDir)})`)

// ---- 3. 建会话 ----
const chatId = `verify_${Date.now()}`
const dir = path.join(botDir, chatId)
ensureDir(dir)

// 会话目录本身不带 Agent 定义：OpenCode 会从会话目录向上找到机器人工作区的项目根。
// 因此能力清单以 botDir 为准（桥接本身也不调用 listAgents，它直接用配置里的 agent 名）。
const agents = await client.listAgents(botDir)
const names = agents.map((a) => a.name)
const expected = ["pm-brain", "pm-a11-requirements", "pm-a54-risk", "pm-a61-deliverable"]
console.log(`\n可发现的 Agent（${names.length}）：${names.join(", ")}`)
for (const name of expected) {
  if (names.includes(name)) ok(`Agent 可发现: ${name}`)
  else fail(`Agent 缺失: ${name}`)
}

// ---- 4. 真实派发 ----
const session = await client.createSession({
  title: "verify pm-agent",
  directory: dir,
  agent: bot.agent,
  model: bot.model,
})
console.log(`\n会话 ${session.id}  agent=${session.agent}  model=${JSON.stringify(session.model)}`)

const ac = new AbortController()
let text = ""
const subagents = new Set()
let terminal = null
const finished = new Promise((resolve) => {
  void (async () => {
    for await (const event of client.streamEvents(ac.signal)) {
      const data = event.data ?? {}
      if (event.type === "session.text.delta" && data.sessionID === session.id) {
        text += String(data.delta ?? "")
      }
      if (event.type === "session.tool.called") {
        const blob = JSON.stringify(data.input ?? data)
        for (const m of blob.matchAll(/pm-a\d\d-[a-z]+/g)) subagents.add(m[0])
      }
      // 只有主会话的终态才算结束；子 Agent 跑在各自会话里。
      if (
        (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") &&
        data.sessionID === session.id
      ) {
        terminal = event.type
        ac.abort()
        resolve()
        return
      }
    }
  })().catch(() => resolve())
})

await client.prompt(session.id, { text: "用一句话说明一次产品上线的合规风险要点。", delivery: "queue" })
await Promise.race([finished, new Promise((r) => setTimeout(r, 300_000))])

// 事件流可能漏收，最终以会话消息为准。
let finalText = text
try {
  const messages = await client.messages(session.id)
  const assistant = messages.filter((m) => m.type === "assistant" && m.text).pop()
  if (assistant?.text) finalText = assistant.text
} catch {
  /* keep streamed text */
}

console.log(`\n[${terminal ?? "timeout"}]`)
console.log("\n--- A0 最终回复 ---\n" + finalText.trim())

const routed = /路由[:：]\s*任务类型=([^,\s]+)/.exec(finalText)
if (routed) ok("A0 输出了路由行", routed[0])
else fail("A0 未输出路由行")
if (subagents.size > 0) ok("观测到子 Agent 调用", [...subagents].join(", "))
else fail("未观测到子 Agent 调用")

await client.deleteSession(session.id).catch(() => {})
fs.rmSync(dir, { recursive: true, force: true })

console.log(process.exitCode === 1 ? "\n结果：存在失败项" : "\n结果：全部通过")
process.exit(process.exitCode ?? 0)
