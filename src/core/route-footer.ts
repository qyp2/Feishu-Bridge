/**
 * Brain 回复末尾固定的「路由: 任务类型=…」尾注。
 * 正式卡片用 note 小字；流式卡片里只能写进同一段 markdown，所以改成短灰字。
 */

const ROUTE_LINE = /路由\s*[:：]\s*任务类型\s*=\s*([^,，\s|]+)/
const ROUTE_LINE_FULL = /(?:^|\n)(路由\s*[:：]\s*任务类型\s*=[^\n]+)/g

const TASK_LABELS: Record<string, string> = {
  opportunity: "商机",
  "intel-digest": "资讯订阅",
  "business-plan": "商业计划",
  "review-meeting": "上会审核",
  "product-request": "产品请示",
  "product-exit": "产品退出",
  "sales-copy": "转化文案",
  requirements: "需求",
  competitor: "竞品",
  market: "市场",
  "rd-plan": "研发",
  "qa-report": "测试",
  "release-material": "发布材料",
  "offer-analysis": "Offer",
  "ops-report": "运营",
  feedback: "反馈",
  leads: "线索",
  followup: "跟进",
  performance: "业绩",
  support: "支持",
  knowledge: "知识",
  partner: "伙伴",
  risk: "风险",
}

export function routeFrom(text: string): string | undefined {
  if (!text) return undefined
  const match = ROUTE_LINE.exec(text)
  return match?.[1]?.trim() || undefined
}

/** 拆出路由尾注：body 给正文，note 给卡片小字。 */
export function peelRouteFooter(text: string): { body: string; note?: string } {
  const source = stripClosingPitch(text || "")
  let note: string | undefined
  const body = source
    .replace(ROUTE_LINE_FULL, (_all, footer: string) => {
      note = compactRoute(String(footer).trim())
      return ""
    })
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
  return note ? { body, note } : { body: source }
}

/** 流式单元素卡片：路由压成一行灰字，避免和正文同级放大。 */
export function styleRouteFooter(text: string): string {
  const { body, note } = peelRouteFooter(text)
  if (!note) return body
  return `${body}\n\n<font color='grey'>┈ ${note}</font>`
}

export function compactRoute(footer: string): string {
  const type = /任务类型\s*=\s*([^,，]+)/.exec(footer)?.[1]?.trim()
  const agents = /正文\s*=\s*([^,，]+)/.exec(footer)?.[1]?.trim()
  const skill = /技能\s*=\s*([^\n]+)/.exec(footer)?.[1]?.trim()
  const typeLabel = TASK_LABELS[type || ""] || type || "任务"
  const agentLabel = (agents || "")
    .split(/\s*\+\s*/)
    .map((item) => shortAgent(item.trim()))
    .filter(Boolean)
    .join("+")
  const skillLabel = shortSkill((skill || "").trim())
  return ["路由", typeLabel, agentLabel, skillLabel].filter(Boolean).join(" · ")
}

function shortAgent(name: string): string {
  const match = /pm-a(\d+)/i.exec(name)
  if (match) return `A${match[1]}`
  return name.replace(/^pm-/i, "")
}

function shortSkill(name: string): string {
  const match = /s(\d+)/i.exec(name)
  if (match) return `S${match[1]}`
  return name
}

function stripClosingPitch(text: string): string {
  const marker = /\n+(?:如果要做成对外的材料|后续入口|接下来你可以|你还可以[:：])/
  const match = marker.exec(text)
  if (!match) return text
  return text.slice(0, match.index).trimEnd()
}
