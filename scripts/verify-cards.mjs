/**
 * 用飞书服务端校验卡片 JSON：POST /open-apis/cardkit/v1/cards 会把内容真正过一遍
 * 校验器，比"本地 JSON 能序列化"靠谱得多（`max_length` 超限这类错误只有服务端会报）。
 *
 * 用法：node scripts/verify-cards.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { skillDeleteConfirmCard, skillFormCard, skillManageCard, skillSavedCard, welcomeCard, helpCard } from "../dist/feishu/cards.js"

const here = path.dirname(fileURLToPath(import.meta.url))
process.chdir(path.resolve(here, ".."))

const config = JSON.parse(fs.readFileSync("config/config.json", "utf8"))
const bot = config.bots[0]

const tokenResp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: bot.appId, app_secret: bot.appSecret }),
})
const token = await tokenResp.json()
if (token.code !== 0) {
  console.error("拿不到 tenant_access_token：", token.msg)
  process.exit(1)
}

const sample = {
  id: "sk_demo0001",
  name: "竞品周报",
  triggers: ["竞品周报", "对手动态"],
  scene: "每周给部门领导看的竞品动态汇总",
  steps: "1. 只取最近 7 天动态，来源优先官网与行业媒体；\n2. 按产品/价格/渠道三段对比；\n3. 结论不超过 5 条。",
  output: "Markdown 表格 + 结论，500 字以内",
  owner: "ou_demo",
  ownerName: "Demo",
  scope: "personal",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  useCount: 2,
}

const cards = {
  "技能管理卡（有内容）": skillManageCard([sample, { ...sample, id: "sk_demo0002", name: "合规红线", scope: "shared" }], true),
  "技能管理卡（空）": skillManageCard([], false),
  "新建技能表单": skillFormCard({}, { isAdmin: false }),
  "管理员技能表单": skillFormCard({}, { isAdmin: true }),
  "编辑技能表单": skillFormCard(
    { id: sample.id, name: sample.name, triggers: sample.triggers, scene: sample.scene, steps: sample.steps, output: sample.output, scope: "personal" },
    { isAdmin: false },
  ),
  "保存成功卡": skillSavedCard(sample, false),
  "删除确认卡": skillDeleteConfirmCard(sample),
  "欢迎卡": welcomeCard(["移动内部汇报"], ["我的周报"]),
  "帮助卡": helpCard(),
}

let failures = 0
for (const [label, card] of Object.entries(cards)) {
  const resp = await fetch("https://open.feishu.cn/open-apis/cardkit/v1/cards", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.tenant_access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "card_json", data: JSON.stringify(card) }),
  })
  const data = await resp.json()
  if (data.code === 0) {
    console.log(`  PASS  ${label}  card_id=${data.data?.card_id ?? "-"}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}  code=${data.code} ${data.msg}`)
  }
}

console.log(failures === 0 ? "\n结果：全部通过（飞书服务端接受了每张卡）" : `\n结果：${failures} 张卡被飞书拒绝`)
process.exit(failures === 0 ? 0 : 1)
