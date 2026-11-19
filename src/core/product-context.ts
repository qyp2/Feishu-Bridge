import fs from "node:fs"

export interface ProductProfile {
  id: string
  name: string
  aliases: string[]
  skillPath: string
}

export interface ProductContextMatch {
  profile: ProductProfile
  keyword: string
}

export const PRODUCT_PROFILE_MUTATION_DENIED =
  "移动安全管家的产品介绍属于只读事实源，主 AGENT 不能直接修改。若要更新产品资料，请使用“移动安全管家”同步机器人维护；我可以基于当前已生效的产品事实继续做分析、方案、商机和竞品任务。"

const PRODUCT_PROFILES: ProductProfile[] = [
  {
    id: "mobile-security-steward",
    name: "移动安全管家",
    aliases: ["移动安全管家", "Mobile Security Steward", "mobile security steward", "MSS"],
    skillPath: "C:/AGENT_FINAL/agent_structure/product-skills/product-intro-01/SKILL.md",
  },
]

type TaskScene = "intel" | "plan" | "cost" | "compete" | "exit" | "brief" | "generic"

export function detectProductContext(botName: string, text: string): ProductContextMatch | undefined {
  if (botName !== "assistant") return undefined
  const hay = text.trim()
  if (!hay) return undefined
  const lower = hay.toLowerCase()
  for (const profile of PRODUCT_PROFILES) {
    for (const alias of profile.aliases) {
      const needle = alias.toLowerCase()
      if (!needle) continue
      if (lower.includes(needle)) return { profile, keyword: alias }
    }
  }
  return undefined
}

export function asksToModifyProductProfile(botName: string, text: string): boolean {
  const matched = detectProductContext(botName, text)
  if (!matched) return false
  const t = text.replace(/\s+/g, "")
  const write = /(更新|修改|补写|同步|维护|改写|写入|覆盖|新增|删除|替换|改成|变更)/.test(t)
  const target = /(产品介绍|产品画像|产品资料|事实源|SKILL\.md|字段|竞品表|画像|产品skill|skill)/i.test(t)
  return write && target
}

export function buildProductContextPrompt(text: string, match: ProductContextMatch): string {
  const skill = readProductSkill(match.profile.skillPath)
  const scene = inferScene(text)
  const focus = focusByScene(scene)
  return [
    "【产品上下文预处理】",
    `本轮任务命中产品「${match.profile.name}」。开始执行前，必须先完整阅读下面这份只读产品事实源，再自行判断哪些内容最适合支撑当前任务。`,
    "要求：",
    "- 先理解整份产品介绍，再提炼与本轮任务最相关的事实；不要机械复述全文，也不要把注入口径写死。",
    `- 本轮任务优先关注：${focus}`,
    "- 你要自己判断哪些章节适合当前任务；不同任务关注点可以不同。",
    "- 只使用现行有效事实：优先 [已拍板]，引用 [沟通中] 必须明确标注“暂定/测算假设”，遇到 【待维护】 不得脑补。",
    "- [已变更/废弃] 仅用于解释历史口径，不得当作现状依据。",
    "- 这份产品事实源只读：不得修改、补写、覆盖、删除，也不要把自己当成维护者。若用户要求改产品介绍，应提醒改走产品同步机器人。",
    `- 后续分析、方案、成本、竞品、商机跟踪等，都必须站在“我方产品 = ${match.profile.name}”的视角展开。`,
    "- 不要先单独输出一段“产品摘要”；请把提炼后的产品认知直接融入你的正常回答和后续子任务说明。",
    "",
    `【产品事实源：${match.profile.name}】`,
    skill,
    "",
    "【本轮任务】",
    text,
  ].join("\n")
}

function readProductSkill(file: string): string {
  let raw = ""
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (error) {
    return `产品事实源读取失败：${error instanceof Error ? error.message : String(error)}`
  }
  return stripFrontmatter(raw).trim()
}

function stripFrontmatter(input: string): string {
  if (!input.startsWith("---")) return input
  const end = input.indexOf("\n---", 3)
  if (end === -1) return input
  return input.slice(end + 4)
}

function inferScene(text: string): TaskScene {
  if (/(商机|资讯订阅|资讯推送|机会|线索|展会|活动推荐|订阅)/.test(text)) return "intel"
  if (/(竞品|对标|竞争|差距矩阵)/.test(text)) return "compete"
  if (/(成本|人天|排期|报价|预算|测算|roi|投入产出)/i.test(text)) return "cost"
  if (/(方案|竞标|投标|拿方案|策略|打法)/.test(text)) return "plan"
  if (/(退出|退市|下线|终止|生命周期|收缩)/.test(text)) return "exit"
  if (/(商业计划书|BP|请示|上会|汇报|立项|规划)/i.test(text)) return "brief"
  return "generic"
}

function focusByScene(scene: TaskScene): string {
  switch (scene) {
    case "intel":
      return "优先提炼可用于持续跟踪的竞品、关键词、客群、场景、近期重点方向和排除边界。"
    case "plan":
      return "优先提炼我方能力、适配场景、差异化优势、合作方式与可转成方案的话术。"
    case "cost":
      return "优先提炼功能范围、交付形态、合作方式、内部/外部约束和任何可支撑成本测算的边界。"
    case "compete":
      return "优先提炼对标产品、竞品阵营、差异化策略、目标客群和我方相对优势/短板。"
    case "exit":
      return "优先提炼生命周期状态、目标客群、版本路线、投入产出、替代关系和退出影响。"
    case "brief":
      return "优先提炼定位、核心价值、市场需求、客户画像、差异化、推广路径和商业化信息。"
    default:
      return "优先提炼最能支撑当前任务判断的产品定位、能力边界、客群、竞品和业务现状。"
  }
}
