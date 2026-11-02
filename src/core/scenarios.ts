/**
 * PPT 的三个固定评审场景。
 *
 * 用户选场景后，桥接把「章节骨架」拼进 prompt，A0 再转给 pm-a61-deliverable
 * 按 s63 的页型成稿——结构由这张表统一，不靠模型每次自由发挥。
 *
 * 加场景只改这个文件：卡片下拉、文字命中、prompt 骨架都会跟着变。
 */
export interface PptScenario {
  /** 卡片 select 的 value，也是 /make ppt <id> 的参数。 */
  id: string
  label: string
  /** 文字命中用的关键词（小写比较）。 */
  keywords: string[]
  /** 章节骨架：顺序固定，标题直接用，每章至少一页。 */
  sections: string[]
  /** 面向谁讲，决定详略与结论口径。 */
  audience: string
  /** 页数区间，写进 prompt 约束篇幅。 */
  pages: string
}

export const PPT_SCENARIOS: PptScenario[] = [
  {
    id: "bp",
    label: "商业计划书",
    keywords: ["商业计划书", "商业计划", "bp"],
    sections: [
      "市场机会与规模",
      "目标客户与核心需求",
      "产品方案与差异化",
      "商业模式与定价",
      "收入与成本预测",
      "投入产出与关键假设",
      "风险与应对",
      "里程碑与资源需求",
      "结论与决策建议",
    ],
    audience: "公司管理层与投资/财务评审",
    pages: "15–20 页",
  },
  {
    id: "request",
    label: "产品化请示",
    keywords: ["产品化请示", "立项请示", "产品化", "立项"],
    sections: [
      "背景与待解决问题",
      "客户需求与证据",
      "产品方案与范围",
      "目标与考核指标",
      "资源与预算",
      "实施计划与里程碑",
      "风险与应对",
      "请示事项",
    ],
    audience: "产品委员会与预算审批人",
    pages: "10–15 页",
  },
  {
    id: "exit",
    label: "产品退出评审",
    keywords: ["退出评审", "产品退出", "下线评审", "退市"],
    sections: [
      "退出对象与存量盘点",
      "退出原因与数据证据",
      "客户影响与迁移方案",
      "财务影响",
      "渠道与合规风险",
      "退出节奏与里程碑",
      "责任分工与善后安排",
      "评审结论建议",
    ],
    audience: "产品委员会与相关业务/合规负责人",
    pages: "10–15 页",
  },
]

export function findScenarioById(id: string | undefined): PptScenario | undefined {
  if (!id) return undefined
  return PPT_SCENARIOS.find((scenario) => scenario.id === id)
}

/** 从自由文字里认场景（「做个产品退出评审的PPT」这类说法）。 */
export function findScenarioInText(text: string): PptScenario | undefined {
  const lower = text.toLowerCase()
  return PPT_SCENARIOS.find((scenario) => scenario.keywords.some((keyword) => lower.includes(keyword)))
}

/** 拼进 prompt 的场景说明：章节顺序、读者、篇幅、缺数据怎么写。 */
export function scenarioPromptBlock(scenario: PptScenario): string {
  const sections = scenario.sections.map((section, index) => `${index + 1}. ${section}`).join("\n")
  return [
    "【制作要求：以下只用于排版，不要抄进正文，也不要放进「关键事实」页】",
    `按「${scenario.label}」的固定评审结构组织，章节顺序不要调整：`,
    sections,
    `面向：${scenario.audience}；篇幅：${scenario.pages}。`,
    "每个章节至少一页，页标题沿用上面的章节名；缺数据的地方写「待补充」，不要编造数字；结论放在最后一部分。",
  ].join("\n")
}
