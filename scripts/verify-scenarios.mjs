/**
 * PPT 场景自检（不调模型、不调飞书服务端）。
 *
 * 校验三件事：
 *  1. 三个场景的章节骨架都进了 prompt；
 *  2. 卡片里只有 PPT 有场景下拉，且选项齐全；
 *  3. 不选场景时能从指令文字里自动认出场景。
 *
 * 用法：node scripts/verify-scenarios.mjs
 */
import { composeMakePrompt, resolveMakeScenario } from "../dist/core/conversations.js"
import { PPT_SCENARIOS, findScenarioInText } from "../dist/core/scenarios.js"
import { makeFormCard } from "../dist/feishu/cards.js"

let failures = 0
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  PASS  ${label}`)
  else {
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`)
    failures++
  }
}

// ---- 1. 骨架进 prompt ----
console.log("场景骨架 → prompt")
for (const scenario of PPT_SCENARIOS) {
  const prompt = composeMakePrompt({ instruction: `做一份「${scenario.label}」`, format: "pptx", scenario: scenario.id })
  const missing = scenario.sections.filter((section) => !prompt.includes(section))
  check(`${scenario.label}：${scenario.sections.length} 个章节齐全`, missing.length === 0, missing.join(" / "))
  check(`${scenario.label}：带读者与篇幅`, prompt.includes(scenario.audience) && prompt.includes(scenario.pages))
  check(`${scenario.label}：仍要求输出 PPT 文件`, prompt.includes("请最终输出 PPT 文件"))
}

// ---- 2. 卡片结构 ----
console.log("\n卡片结构")
const pptCard = JSON.stringify(makeFormCard({ format: "pptx", files: [], sharedTemplates: [], personalTemplates: [] }))
check("PPT 表单里有 scenario 下拉", pptCard.includes('"name":"scenario"') || pptCard.includes('"name": "scenario"'))
const optionCount = PPT_SCENARIOS.filter((item) => pptCard.includes(`"${item.id}"`)).length
check(`下拉包含全部 ${PPT_SCENARIOS.length} 个场景`, optionCount === PPT_SCENARIOS.length, `只找到 ${optionCount} 个`)
const docxCard = JSON.stringify(makeFormCard({ format: "docx", files: [], sharedTemplates: [], personalTemplates: [] }))
check("Word 表单没有场景下拉", !docxCard.includes('"name":"scenario"') && !docxCard.includes('"name": "scenario"'))
const presetCard = JSON.stringify(
  makeFormCard({ format: "pptx", files: [], sharedTemplates: [], personalTemplates: [] }, { scenario: "exit" }),
)
check("预选场景写进 initial_option", presetCard.includes('"initial_option":"exit"') || presetCard.includes('"initial_option": "exit"'))

// ---- 3. 文字自动识别 ----
console.log("\n指令文字自动识别")
const samples = [
  ["帮我做一份产品退出评审的PPT", "exit"],
  ["做一份商业计划书，20页", "bp"],
  ["出一个产品化请示的幻灯片", "request"],
]
for (const [text, expected] of samples) {
  const scene = resolveMakeScenario({ instruction: text, format: "pptx" })
  check(`「${text}」→ ${expected}`, scene?.id === expected, `识别为 ${scene?.id ?? "无"}`)
}
check("Word 不会误套 PPT 场景", resolveMakeScenario({ instruction: "商业计划书", format: "docx" }) === undefined)
const noScene = composeMakePrompt({ instruction: "做一份通用汇报", format: "pptx" })
check("没有场景词时不追加骨架", !noScene.includes("章节顺序不要调整"))

console.log(failures === 0 ? "\n结果：全部通过" : `\n结果：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
