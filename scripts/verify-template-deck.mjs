/**
 * Smoke-test apply-template against shared enterprise templates.
 * usage: node scripts/verify-template-deck.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fillTemplate } from "./apply-template.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const templates = [
  path.join(root, "data/templates/shared/移动风格.pptx"),
  path.join(root, "data/templates/shared/移动内部汇报.pptx"),
]
const sampleMd = path.join(
  root,
  "data/workspaces/assistant/oc_020c589a2ccd56d5471940c4b4268700/deliverables/新一代路内智慧停车解决方案（广州巨时）商业计划书_移动风格.md",
)

const chartSmoke = `# 图表冒烟

## 占比

\`\`\`chart
pie
| 项目 | 占比 |
| --- | --- |
| A | 35% |
| B | 65% |
\`\`\`
`
const markdown = fs.existsSync(sampleMd) ? fs.readFileSync(sampleMd, "utf8") : chartSmoke

const outDir = path.join(root, "data/templates/_verify-out")
fs.mkdirSync(outDir, { recursive: true })

for (const templatePath of templates) {
  if (!fs.existsSync(templatePath)) {
    console.warn("skip missing", templatePath)
    continue
  }
  const outPath = path.join(outDir, `${path.basename(templatePath, ".pptx")}-out.pptx`)
  const result = await fillTemplate({ templatePath, outPath, markdown })
  console.log("ok", path.basename(templatePath), result)
}
