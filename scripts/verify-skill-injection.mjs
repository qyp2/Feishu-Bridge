/**
 * 端到端验证：个性化技能命中后，注入的指令是否真的被 PM-Agent 执行。
 *
 * 做法：建一条格式约束很强的技能（只能用固定三段），把注入块拼进用户消息，
 * 真跑一轮会话，检查回复是否遵守了这条技能的格式。
 *
 * 用法：node scripts/verify-skill-injection.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../dist/config/index.js"
import { OpencodeService } from "../dist/opencode/service.js"
import { Logger } from "../dist/util/logger.js"
import { ensureDir } from "../dist/util/paths.js"
import { SkillStore, renderSkillBlock } from "../dist/skills/store.js"
import { TurnAccumulator } from "../dist/core/turn.js"

const here = path.dirname(fileURLToPath(import.meta.url))
process.chdir(path.resolve(here, ".."))

const { config } = loadConfig()
const bot = config.bots[0]
const logger = new Logger({ level: "warn", pretty: true, name: "verify-skill" })
const store = new SkillStore(config.storageDir)
const owner = "ou_verify_skill"

let failures = 0
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  PASS  ${label}`)
  else {
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`)
    failures++
  }
}

// 1) 建技能 + 命中判定
const skill = store.save(owner, {
  name: "合规三段速评",
  triggers: ["合规速评"],
  scene: "一句话交代上线合规要点",
  steps:
    "严格只输出三行，不要开场白、不要结尾建议、不要表格：\n" +
    "第一行以「①风险：」开头，写最主要的合规风险；\n" +
    "第二行以「②影响：」开头，写触发后的后果；\n" +
    "第三行以「③动作：」开头，写现在就该做的一件事。",
  output: "恰好三行，每行不超过 40 字。",
})
console.log(`技能已建：${skill.name}（${skill.id}）`)

const hits = store.match("来一份合规速评", owner)
check("触发词命中", hits.length === 1 && hits[0].skill.id === skill.id)
const block = renderSkillBlock(hits[0].skill)

// 卡片标题前缀（used by the streaming card）
const acc = new TurnAccumulator(true, false)
acc.titlePrefix = `🧩 ${skill.name}`
acc.addText("m1", 0, "正文")
const rendered = acc.render("live")
check("卡片标题带上技能名", rendered.includes(skill.name), rendered.slice(0, 60))

// 2) 真跑一轮
const service = new OpencodeService(config.opencode, logger)
const client = await service.client()

const botDir = path.join(bot.location, bot.name)
const dir = path.join(botDir, `skill_verify_${Date.now()}`)
ensureDir(dir)

const session = await client.createSession({
  title: "verify skill injection",
  directory: dir,
  agent: bot.agent,
  model: bot.model,
})

const prompt = `我们准备把一款新产品上线，来一份合规速评。\n\n---\n${block}`
console.log("\n--- 实际发出的 prompt ---\n" + prompt + "\n")

let text = ""
const ac = new AbortController()
const finished = new Promise((resolve) => {
  void (async () => {
    for await (const event of client.streamEvents(ac.signal)) {
      const data = event.data ?? {}
      if (event.type === "session.text.delta" && data.sessionID === session.id) text += String(data.delta ?? "")
      if (
        (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") &&
        data.sessionID === session.id
      ) {
        ac.abort()
        resolve()
        return
      }
    }
  })().catch(() => resolve())
})

await client.prompt(session.id, { text: prompt, delivery: "queue" })
await Promise.race([finished, new Promise((r) => setTimeout(r, 300_000))])

try {
  const messages = await client.messages(session.id)
  const assistant = messages.filter((m) => m.type === "assistant" && m.text).pop()
  if (assistant?.text) text = assistant.text
} catch {
  /* keep streamed text */
}

const answer = text.trim()
console.log("\n--- Agent 回复 ---\n" + answer + "\n")

check("用了①风险：", answer.includes("①风险"))
check("用了②影响：", answer.includes("②影响"))
check("用了③动作：", answer.includes("③动作"))
const lines = answer.split("\n").map((line) => line.trim()).filter(Boolean)
check("控制在三行左右（≤4 行）", lines.length <= 4, `实际 ${lines.length} 行`)
check("没有输出表格", !answer.includes("| ---"))

await client.deleteSession(session.id).catch(() => {})
fs.rmSync(dir, { recursive: true, force: true })
store.remove(owner, skill.id, { allowShared: true })

console.log(failures === 0 ? "\n结果：全部通过（技能指令被真实执行）" : `\n结果：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
