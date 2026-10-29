/**
 * 个性化技能：存储与命中判定的单元校验（不触网、不调模型）。
 *
 * 用法：node scripts/verify-skills.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  SkillStore,
  parseTriggers,
  renderSkillBlock,
  validateSkillDraft,
} from "../dist/skills/store.js"
import {
  skillDeleteConfirmCard,
  skillFormCard,
  skillManageCard,
  skillSavedCard,
} from "../dist/feishu/cards.js"

const here = path.dirname(fileURLToPath(import.meta.url))
process.chdir(path.resolve(here, ".."))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-store-"))
const store = new SkillStore(tmp)
const ALICE = "ou_alice"
const BOB = "ou_bob"

let failures = 0
function check(label, condition, detail = "") {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`)
    failures++
  }
}
function throws(label, fn, match) {
  try {
    fn()
    check(label, false, "没有抛错")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(label, match ? message.includes(match) : true, message)
  }
}

// ---- 触发词解析 ----
check("触发词按中英文逗号/空格拆分", parseTriggers("竞品周报, 对手动态、竞品每周").length === 3)
check("触发词去重前的空项被丢弃", parseTriggers(" , , ").length === 0)

// ---- 校验 ----
check("名称太短被拒", Boolean(validateSkillDraft({ name: "A", triggers: ["abc"], steps: "1234567890" })))
check(
  "合法草稿通过",
  validateSkillDraft({ name: "竞品周报", triggers: ["竞品周报"], steps: "先查官网，再按三段对比。" }) === undefined,
)

// ---- 保存 / 读取 ----
const weekly = store.save(
  ALICE,
  {
    name: "竞品周报",
    triggers: parseTriggers("竞品周报 对手动态"),
    scene: "每周给领导看的竞品动态汇总",
    steps: "1. 只取最近 7 天动态；2. 按产品/价格/渠道三段对比；3. 结论不超过 5 条。",
    output: "Markdown 表格 + 结论，500 字以内",
  },
  { ownerName: "Alice" },
)
check("个人技能落盘", fs.existsSync(path.join(tmp, "skills", ALICE, `${weekly.id}.json`)))
check("按名称能取回", store.get(ALICE, "竞品周报")?.id === weekly.id)
check("按 id 能取回", store.get(ALICE, weekly.id)?.name === "竞品周报")

// ---- 隔离 ----
check("别人的技能列表里看不到", store.list(BOB).length === 0)
check("别人按名称取不到", store.get(BOB, "竞品周报") === undefined)

// ---- 命中 ----
check("触发词子串命中", store.match("帮我做一份本周竞品周报", ALICE).length === 1)
check("无关的话不命中", store.match("今天天气怎么样", ALICE).length === 0)
check("显式点名命中（用XX技能）", store.match("用竞品周报技能跑一下", ALICE)[0]?.trigger === "竞品周报")
check("显式点名命中（@XX）", store.match("@竞品周报 现在开始", ALICE)[0]?.skill.id === weekly.id)

// 长触发词优先
const longer = store.save(ALICE, {
  name: "竞品周报深度版",
  triggers: ["竞品周报深度"],
  steps: "在周报基础上补充对手财报数据与渠道动作。",
})
const hits = store.match("来一份竞品周报深度", ALICE)
check("更长的触发词排在前面", hits[0]?.skill.id === longer.id, hits.map((h) => h.trigger).join("|"))

// ---- 共享 ----
throws("非管理员不能建共享技能", () =>
  store.save(BOB, { name: "员工业绩榜", triggers: ["业绩榜"], steps: "按季度统计各团队业绩并排名。", scope: "shared" }),
"管理员")
const shared = store.save(
  ALICE,
  { name: "合规红线", triggers: ["合规红线"], steps: "列出监管红线与对应风险等级。", scope: "shared" },
  { allowShared: true, ownerName: "Alice" },
)
check("共享技能对他人可见", store.list(BOB).some((skill) => skill.id === shared.id))
check("共享技能文件在 _shared 目录", fs.existsSync(path.join(tmp, "skills", "_shared", `${shared.id}.json`)))
check("他人不能删共享技能", store.remove(BOB, shared.id, { allowShared: false }) === undefined)
check("共享技能仍在", store.get(BOB, shared.id)?.id === shared.id)

// ---- 重名 ----
throws("同范围重名被拒", () => store.save(ALICE, { name: "竞品周报", triggers: ["周报"], steps: "重复的名字应该被拦住。" }), "同名")

// ---- 编辑保留 id 与计数 ----
store.markUsed(weekly)
const edited = store.save(
  ALICE,
  {
    id: weekly.id,
    name: weekly.name,
    triggers: weekly.triggers,
    scene: weekly.scene,
    steps: `${weekly.steps}\n4. 附一句下阶段建议。`,
    output: weekly.output,
    scope: "personal",
  },
  { ownerName: "Alice" },
)
check("编辑沿用同一 id", edited.id === weekly.id)
check("编辑保留使用计数", edited.useCount === 1, String(edited.useCount))
check("编辑更新正文", edited.steps.includes("下阶段建议"))

// ---- 注入文本 ----
const block = renderSkillBlock(edited)
check("注入块带技能名", block.includes("【个性化技能：竞品周报】"))
check("注入块带步骤", block.includes("下阶段建议"))
check("注入块带输出要求", block.includes("输出要求"))

// ---- 卡片结构 ----
const cards = {
  管理卡: skillManageCard(store.list(ALICE), false),
  空管理卡: skillManageCard([], true),
  新建表单: skillFormCard({}, { isAdmin: false }),
  管理员表单: skillFormCard({}, { isAdmin: true }),
  编辑表单: skillFormCard({ id: weekly.id, name: weekly.name, triggers: weekly.triggers, steps: weekly.steps }, { isAdmin: false }),
  保存卡: skillSavedCard(edited, false),
  删除确认: skillDeleteConfirmCard(edited),
}
for (const [label, card] of Object.entries(cards)) {
  const json = JSON.stringify(card)
  check(`卡片可序列化：${label}`, json.length > 100 && !json.includes('"undefined"'), String(json.length))
}
const formJson = JSON.stringify(cards.新建表单)
check("表单含名称/触发词/步骤字段", ["name", "triggers", "steps"].every((field) => formJson.includes(`"${field}"`)))
check("普通用户表单不含共享选项", !formJson.includes("全部业务会话"))
check("管理员表单含共享选项", JSON.stringify(cards.管理员表单).includes("shared"))

// ---- 删除 ----
const removed = store.remove(ALICE, weekly.id)
check("删除返回被删技能", removed?.id === weekly.id)
check("删除后取不到", store.get(ALICE, weekly.id) === undefined)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? "\n结果：全部通过" : `\n结果：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
