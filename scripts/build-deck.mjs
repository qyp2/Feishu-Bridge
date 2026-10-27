import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

const require = createRequire(import.meta.url)
const PptxGenJS = require("pptxgenjs")
const FONT = "Microsoft YaHei"

const args = process.argv.slice(2)
function flag(name) {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  return value?.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
}

const markdownPath = flag("--markdown")
const outPath = flag("--out")
if (!markdownPath || !outPath) {
  console.error("usage: node build-deck.mjs --markdown file.md --out file.pptx [--template file.pptx]")
  process.exit(1)
}

const markdown = fs.readFileSync(markdownPath, "utf8").replace(/\r\n/g, "\n")
const model = parseMarkdown(markdown)
const templatePath = flag("--template")
if (templatePath && fs.existsSync(templatePath)) {
  try {
    const { fillTemplate } = await import("./apply-template.mjs")
    await fillTemplate({ templatePath, outPath: path.resolve(outPath), markdown })
    console.log(path.resolve(outPath))
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    if (message.includes("不会接受") || message.includes("根组合")) process.exit(1)
  }
}
const pptx = new PptxGenJS()
pptx.layout = "LAYOUT_WIDE"
pptx.theme = { headFontFace: FONT, bodyFontFace: FONT }
const cover = pptx.addSlide()
cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: "1F4E79" } })
cover.addText(model.title, {
  x: 0.7,
  y: 2.3,
  w: 11.5,
  h: 1.4,
  fontSize: 36,
  bold: true,
  fontFace: FONT,
  color: "1F4E79",
})
let pages = 1
for (const section of model.sections) {
  const groups = pieceGroups(slidePieces(section.body))
  for (const group of groups) {
    if (pages >= 40) break
    const slide = pptx.addSlide()
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.12, h: 7.5, fill: { color: "1F4E79" } })
    slide.addText(cleanInline(section.heading) || "正文", {
      x: 0.55,
      y: 0.28,
      w: 12,
      h: 0.62,
      fontSize: 28,
      bold: true,
      fontFace: FONT,
      color: "1F4E79",
      margin: 0,
    })
    slide.addShape(pptx.ShapeType.rect, { x: 0.55, y: 1.02, w: 2.2, h: 0.045, fill: { color: "1F4E79" } })
    slide.addText(toRuns(group), { x: 0.55, y: 1.25, w: 12.1, h: 5.7, fontFace: FONT, valign: "top" })
    pages += 1
  }
}
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
await pptx.writeFile({ fileName: path.resolve(outPath) })
console.log(path.resolve(outPath))

function parseMarkdown(markdown) {
  const lines = markdown.split("\n")
  let title = ""
  const sections = []
  let current
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const text = cleanInline(heading[2] ?? "")
      if ((heading[1]?.length ?? 0) === 1 && !title) {
        title = text
        continue
      }
      if (current) sections.push(current)
      current = { heading: text, body: [] }
      continue
    }
    if (!current) {
      if (!line.trim()) continue
      if (!title) title = cleanInline(line)
      else current = { heading: title, body: [line] }
      continue
    }
    current.body.push(line)
  }
  if (current) sections.push(current)
  const cleaned = sections
    .map((section) => ({ heading: section.heading, body: section.body.join("\n").trim() }))
    .filter((section) => section.heading.length > 0 || section.body.length > 0)
  if (cleaned.length === 0) cleaned.push({ heading: title || "正文", body: markdown.trim() })
  return { title: title || cleaned[0]?.heading || "文档", sections: cleaned }
}

function slidePieces(body) {
  const pieces = []
  for (const raw of body.split("\n")) {
    const line = raw.trim()
    if (!line || line === "---") continue
    const onlyLabel = /^\*\*(.+?)\*\*\s*[:：]?\s*$/.exec(line)
    if (onlyLabel) {
      const text = cleanInline(onlyLabel[1] ?? "")
      if (text) pieces.push({ role: "subtitle", text })
      continue
    }
    const labelThen = /^\*\*(.+?)\*\*\s*[:：]\s*(.+)$/.exec(line)
    if (labelThen) {
      const label = cleanInline(labelThen[1] ?? "")
      const rest = cleanInline(labelThen[2] ?? "")
      if (label) pieces.push({ role: "subtitle", text: label })
      if (rest) pieces.push({ role: "body", text: rest })
      continue
    }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line)
    if (bullet) {
      const text = cleanInline(bullet[1] ?? "")
      if (text) pieces.push({ role: "bullet", text })
      continue
    }
    const text = cleanInline(line)
    if (text) pieces.push({ role: "body", text })
  }
  const first = pieces[0]
  if (first?.role === "body" && first.text.length <= 40 && pieces.slice(1).some((piece) => piece.role === "bullet")) {
    pieces[0] = { role: "subtitle", text: first.text }
  }
  return pieces.length > 0 ? pieces : [{ role: "body", text: "未提供" }]
}

/** Pack pieces by estimated rendered height so pages fill evenly. */
function pieceGroups(pieces) {
  const budget = 4700000
  const groups = []
  let current = []
  let used = 0
  for (const piece of pieces) {
    const height = estimateHeight(piece)
    if (current.length > 0 && used + height > budget) {
      groups.push(current)
      current = []
      used = 0
    }
    current.push(piece)
    used += height
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function estimateHeight(piece) {
  const size = (piece.role === "subtitle" ? 18 : 16) * 12700
  const lineWidth = 11100000
  let units = 0
  for (const ch of piece.text) units += ch.codePointAt(0) > 0x2e7f ? 1000 : 560
  const lines = Math.max(Math.ceil(((units / 1000) * size) / lineWidth), 1)
  return lines * size * 1.15 + (piece.role === "subtitle" ? 12 : 7) * 12700
}

function toRuns(pieces) {
  return pieces.map((piece) => {
    if (piece.role === "subtitle") {
      return { text: piece.text, options: { fontFace: FONT, fontSize: 18, bold: true, color: "1F4E79", breakLine: true, paraSpaceBefore: 12, paraSpaceAfter: 4 } }
    }
    if (piece.role === "bullet") {
      return { text: piece.text, options: { fontFace: FONT, fontSize: 16, color: "333333", bullet: { indent: 16 }, breakLine: true, paraSpaceAfter: 6 } }
    }
    return { text: piece.text, options: { fontFace: FONT, fontSize: 16, color: "444444", breakLine: true, paraSpaceAfter: 8 } }
  })
}

function cleanInline(value) {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}
