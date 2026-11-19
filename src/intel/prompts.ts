import type { IntelItem } from "./archive.js"

export type IntelScene = "cost" | "compete" | "plan"

const CMHK_ADVANTAGES = [
  "MyLink APP 统一入口",
  "网络侧/通信管道控制力",
  "香港 PDPO 数据落座合规",
  "门市/政企 V 网覆盖",
]

const SCENE_TASK: Record<IntelScene, string> = {
  plan: "调阅目标机构历史选标偏好，给出 CMHK 竞标策略。",
  cost: "输出研发人天、硬件/API 运营成本及排期建议。",
  compete: "调阅该竞品历史轨迹，输出差距对比矩阵。",
}

export function domainNameFromTopic(topic: string): string {
  if (/网安|安全|cyber|vulnerab/i.test(topic)) return "网安"
  if (/办公|office|协作/i.test(topic)) return "办公"
  if (/教育|edu|学校|校园/i.test(topic)) return "教育"
  if (/娱乐|流媒体|内容平台/i.test(topic)) return "娱乐"
  if (/算力|智算|计算|computing/i.test(topic)) return "算力"
  if (/手机|移动业务|mobile/i.test(topic)) return "手机业务"
  return "产品"
}

export function teamHeader(topic: string): string {
  const name = domainNameFromTopic(topic)
  return (
    `我们是中国移动香港 产品部门中心【${name}】团队。` +
    "你是由中国移动香港 (CMHK) 打造的专属商业情报与竞标 Copilot。"
  )
}

export function sourceFooter(sourceUrl: string): string {
  return `\n---\n🔗 **情报溯源与出处链接**\n└─ [查看原文/标案链接](${sourceUrl})`
}

export function appendSourceFooter(markdown: string, sourceUrl: string): string {
  const footer = sourceFooter(sourceUrl)
  const body = (markdown || "").trimEnd()
  if (body.endsWith(footer) || body.endsWith(footer.trimStart())) return body.endsWith(footer) ? body : body.replace(/\n?---[\s\S]*$/, "") + footer
  return body + footer
}

export function intelActionPrompt(
  scene: IntelScene,
  topic: string,
  item: IntelItem,
  history: IntelItem[],
  trackedEntities: string[] = [],
): string {
  const header = teamHeader(topic)
  const advantages = CMHK_ADVANTAGES.map((line) => `- ${line}`).join("\n")
  const watched = trackedEntities.filter(Boolean).join("、") || "无"
  const trail = history
    .filter((row) => row.id !== item.id)
    .map((row) => `- ${row.date} ${row.title}`)
    .join("\n")
  return [
    header,
    "",
    "基础规则：以下是 CMHK 已经具备的能力，分析时当作我方基线，不要写成待建设。",
    advantages,
    "",
    `任务：${SCENE_TASK[scene]}`,
    `订阅主题：${topic}`,
    `资讯标题：${item.title}`,
    `资讯摘要：${item.summary}`,
    `原文链接：${item.url}`,
    `已关注实体：${watched}`,
    "历史推送：",
    trail || "- 暂无历史推送",
    "",
    "用中文 Markdown 回答。只回复可放进飞书卡片的正文，不要写开场白，不要生成文件，不要写 [[send-file: ...]]。",
    "成本、人天、金额没有依据时写「待核实」，不要编造数字。",
    `回答末尾单独附一行溯源：🔗 [查看原文/标案链接](${item.url})`,
  ].join("\n")
}

/** Drop file markers the model sometimes appends. Empty means the turn failed. */
export function presentIntelReply(text: string | undefined): string {
  if (!text) return ""
  return text
    .replace(/\[\[\s*send-(?:file|image)\s*:[\s\S]*?\]\]?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 3500)
}
