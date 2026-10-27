import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx"
import PDFDocument from "pdfkit"

const require = createRequire(import.meta.url)

interface PptxTextPart {
  text: string
  options: Record<string, unknown>
}

interface PptxSlide {
  addText(text: string | PptxTextPart[], options: Record<string, unknown>): void
  addShape(shape: string, options: Record<string, unknown>): void
}

interface PptxDeck {
  layout: string
  theme: { headFontFace: string; bodyFontFace: string }
  ShapeType: { rect: string }
  addSlide(): PptxSlide
  writeFile(props: { fileName: string }): Promise<string>
}

const PptxGenJS = require("pptxgenjs") as new () => PptxDeck

export type OfficeFormat = "pptx" | "docx" | "pdf" | "xlsx"

export interface DocSection {
  heading: string
  body: string
}

export interface DocModel {
  title: string
  sections: DocSection[]
}

const FONT = "Microsoft YaHei"
const PDF_FONT = ["C:\\Windows\\Fonts\\Deng.ttf", "C:\\Windows\\Fonts\\msyh.ttf", "C:\\Windows\\Fonts\\simhei.ttf"]

/** Which office files this user message is asking to receive. */
export function requestedFormats(text: string, fileNames: string[]): OfficeFormat[] {
  const formats = new Set<OfficeFormat>()
  if (/pptx|\bppt\b|幻灯/i.test(text)) formats.add("pptx")
  if (/pdf/i.test(text)) formats.add("pdf")
  if (/docx|\bword\b|word\s*文档/i.test(text)) formats.add("docx")
  if (/xlsx|excel|表格|工作簿/i.test(text)) formats.add("xlsx")
  if (formats.size === 0 && /制作|生成|成稿|导出|写成/.test(text)) {
    const names = fileNames.join(" ")
    if (/pptx|\.ppt\b/i.test(names)) formats.add("pptx")
    if (/docx|\.doc\b/i.test(names)) formats.add("docx")
    if (/\.pdf\b/i.test(names)) formats.add("pdf")
    if (/xlsx|\.xls\b/i.test(names)) formats.add("xlsx")
  }
  return [...formats]
}

export function parseMarkdown(markdown: string): DocModel {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  let title = ""
  const sections: { heading: string; body: string[] }[] = []
  let current: { heading: string; body: string[] } | undefined
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const text = heading[2]?.trim() ?? ""
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
      if (!title) title = line.trim()
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

export async function emitRequestedOffice(options: {
  directory: string
  requestText: string
  fileNames: string[]
  startedAt: number
  templatePath?: string
}): Promise<{ outputs: string[]; sources: string[] }> {
  const formats = requestedFormats(options.requestText, options.fileNames)
  if (formats.length === 0) return { outputs: [], sources: [] }
  const source = latestDeliverableMarkdown(options.directory, options.startedAt)
  if (!source) return { outputs: [], sources: [] }
  return emitOfficeFile({
    source,
    requestText: options.requestText,
    fileNames: options.fileNames,
    templatePath: options.templatePath,
  })
}

/** Newest markdown written under deliverables/ during this turn. */
export function latestDeliverableMarkdown(directory: string, startedAt: number): string | undefined {
  const dir = path.join(directory, "deliverables")
  if (!fs.existsSync(dir)) return undefined
  const sources = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).mtimeMs + 1000 >= startedAt
      } catch {
        return false
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return sources[0]
}

/** Build the office files for one markdown deliverable. */
export async function emitOfficeFile(options: {
  source: string
  requestText: string
  fileNames: string[]
  templatePath?: string
}): Promise<{ outputs: string[]; sources: string[] }> {
  const formats = requestedFormats(options.requestText, options.fileNames)
  if (formats.length === 0) return { outputs: [], sources: [] }
  const source = options.source
  if (!fs.existsSync(source)) return { outputs: [], sources: [] }
  const markdown = fs.readFileSync(source, "utf8")
  const model = parseMarkdown(markdown)
  const base = path.basename(source, path.extname(source)).replace(/[\\/:*?"<>|]/g, "") || "deliverable"
  const outputs: string[] = []
  const dir = path.dirname(source)
  for (const format of formats) {
    const dest = path.join(dir, `${base}.${format}`)
    if (format === "pptx" && !options.templatePath && keepExistingDeck(dest, source)) {
      outputs.push(dest)
      continue
    }
    if (format === "pptx") await writePptx(dest, model, options.templatePath, markdown)
    else if (format === "docx") await writeDocx(dest, model)
    else if (format === "xlsx") await writeXlsx(dest, model, fs.readFileSync(source, "utf8"))
    else await writePdf(dest, model)
    outputs.push(dest)
  }
  return { outputs, sources: [source] }
}

function keepExistingDeck(dest: string, source: string): boolean {
  if (!fs.existsSync(dest)) return false
  return fs.statSync(dest).mtimeMs + 1000 >= fs.statSync(source).mtimeMs
}

async function writeDocx(dest: string, model: DocModel): Promise<void> {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: model.title, font: FONT, size: 36 })],
    }),
  ]
  for (const section of model.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: section.heading, font: FONT, size: 28 })],
      }),
    )
    for (const piece of slidePieces(section.body)) {
      const size = piece.role === "subtitle" ? 24 : 22
      const text = piece.role === "bullet" ? `• ${piece.text}` : piece.text
      children.push(
        new Paragraph({
          children: [new TextRun({ text: text || " ", font: FONT, size, bold: piece.role === "subtitle" })],
        }),
      )
    }
  }
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children }] }))
  fs.writeFileSync(dest, buffer)
}

async function writePptx(dest: string, model: DocModel, templatePath?: string, markdown?: string): Promise<void> {
  if (templatePath && fs.existsSync(templatePath) && markdown) {
    try {
      await writePptxFromTemplate(dest, templatePath, markdown)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("不会接受") || message.includes("根组合")) throw error
      console.error(message)
    }
  }
  const pptx = new PptxGenJS()
  pptx.layout = "LAYOUT_WIDE"
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT }
  const cover = pptx.addSlide()
  cover.addText(model.title, {
    x: 0.6,
    y: 2.2,
    w: 12,
    h: 1.5,
    fontSize: 32,
    fontFace: FONT,
    color: "1F4E79",
  })
  let pages = 1
  for (const section of model.sections) {
    for (const group of pieceGroups(slidePieces(section.body))) {
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
      slide.addText(toRuns(group), {
        x: 0.55,
        y: 1.25,
        w: 12.1,
        h: 5.7,
        fontFace: FONT,
        valign: "top",
      })
      pages += 1
    }
  }
  await pptx.writeFile({ fileName: dest })
}

const templateScript = fileURLToPath(new URL("../../scripts/apply-template.mjs", import.meta.url))

async function writePptxFromTemplate(dest: string, templatePath: string, markdown: string): Promise<void> {
  const mod = (await import(pathToFileURL(templateScript).href)) as {
    fillTemplate(input: { templatePath: string; outPath: string; markdown: string }): Promise<unknown>
  }
  await mod.fillTemplate({ templatePath, outPath: dest, markdown })
}

async function writeXlsx(dest: string, model: DocModel, markdown: string): Promise<void> {
  const ExcelJS = require("exceljs") as { Workbook: new () => ExcelWorkbook }
  const workbook = new ExcelJS.Workbook()
  const used = new Set<string>()
  const tables = markdownTables(markdown)
  if (tables.length === 0) {
    addSectionSheet(workbook, uniqueSheetName("章节", used), model)
  } else {
    tables.forEach((table, index) => addTableSheet(workbook, uniqueSheetName(table.name || `表格${index + 1}`, used), table.rows))
    addSectionSheet(workbook, uniqueSheetName("章节", used), model)
  }
  await workbook.xlsx.writeFile(dest)
}

function addSectionSheet(workbook: ExcelWorkbook, name: string, model: DocModel): void {
  const sheet = workbook.addWorksheet(name)
  sheet.columns = [
    { header: "章节", key: "heading", width: 28 },
    { header: "内容", key: "body", width: 88 },
  ]
  styleHeader(sheet)
  for (const section of model.sections) {
    const body = slidePieces(section.body)
      .map((piece) => (piece.role === "bullet" ? `• ${piece.text}` : piece.text))
      .join("\n")
    const row = sheet.addRow({ heading: cleanInline(section.heading), body })
    row.alignment = { wrapText: true, vertical: "top" }
    row.font = { name: FONT, size: 11 }
  }
}

function addTableSheet(workbook: ExcelWorkbook, name: string, rows: string[][]): void {
  const sheet = workbook.addWorksheet(name)
  const width = Math.max(...rows.map((row) => row.length), 1)
  sheet.columns = Array.from({ length: width }, (_, index) => ({
    header: rows[0]?.[index] || `列${index + 1}`,
    key: `c${index}`,
    width: 24,
  }))
  styleHeader(sheet)
  for (const row of rows.slice(1)) {
    const record: Record<string, string> = {}
    row.forEach((cell, index) => {
      record[`c${index}`] = cell
    })
    const added = sheet.addRow(record)
    added.alignment = { wrapText: true, vertical: "top" }
    added.font = { name: FONT, size: 11 }
  }
}

function styleHeader(sheet: ExcelWorksheet): void {
  const header = sheet.getRow(1)
  header.font = { name: FONT, size: 12, bold: true, color: { argb: "FFFFFFFF" } }
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } }
  header.alignment = { vertical: "middle" }
}

function uniqueSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/*?:[\]]/g, "").trim().slice(0, 31) || "工作表"
  let next = base
  let n = 2
  while (used.has(next)) {
    const suffix = ` ${n}`
    next = `${base.slice(0, 31 - suffix.length)}${suffix}`
    n += 1
  }
  used.add(next)
  return next
}

function markdownTables(markdown: string): { name: string; rows: string[][] }[] {
  const tables: { name: string; rows: string[][] }[] = []
  let title = "表格"
  let current: string[][] | undefined
  const flush = () => {
    if (current && current.length > 0) tables.push({ name: title, rows: current })
    current = undefined
  }
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim()
    const heading = /^#{1,3}\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      title = cleanInline(heading[1] ?? "") || "表格"
      continue
    }
    if (line.startsWith("|")) {
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cleanInline(cell))
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
      if (!current) current = []
      current.push(cells)
      continue
    }
    flush()
  }
  flush()
  return tables
}

interface ExcelRow {
  font: { name?: string; size?: number; bold?: boolean; color?: { argb: string } }
  fill: { type: string; pattern: string; fgColor: { argb: string } }
  alignment: { wrapText?: boolean; vertical?: string }
}

interface ExcelWorksheet {
  columns: { header: string; key: string; width: number }[]
  addRow(row: Record<string, string>): ExcelRow
  getRow(index: number): ExcelRow
}

interface ExcelWorkbook {
  addWorksheet(name: string): ExcelWorksheet
  xlsx: { writeFile(fileName: string): Promise<void> }
}

function writePdf(dest: string, model: DocModel): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 })
    const stream = fs.createWriteStream(dest)
    doc.pipe(stream)
    stream.on("finish", () => resolve())
    stream.on("error", reject)
    doc.on("error", reject)
    const font = PDF_FONT.find((file) => fs.existsSync(file))
    if (font) doc.font(font)
    doc.fontSize(22).fillColor("#1F4E79").text(model.title)
    for (const section of model.sections) {
      doc.moveDown()
      doc.fontSize(16).fillColor("#1F4E79").text(cleanInline(section.heading) || "正文")
      doc.moveDown(0.4)
      for (const piece of slidePieces(section.body)) {
        const text = piece.role === "bullet" ? `• ${piece.text}` : piece.text
        if (piece.role === "subtitle") doc.fontSize(13).fillColor("#1F4E79").text(text, { lineGap: 3 })
        else doc.fontSize(12).fillColor("#333333").text(text, { lineGap: 3 })
      }
    }
    doc.end()
  })
}

export interface ContentGap {
  key: string
  heading: string
}

/** Sections whose body is empty or only the placeholder 「未提供」. */
export function findContentGaps(markdown: string): ContentGap[] {
  return parseMarkdown(markdown).sections.flatMap((section, index) =>
    isGapBody(section.body) ? [{ key: `g${index}`, heading: section.heading }] : [],
  )
}

/**
 * Replace gap sections with the text the user typed.
 * Keys are the section indexes from `findContentGaps` (`g0`, `g1`, …).
 * Blank answers leave the placeholder in place. Non-gap sections are not touched.
 */
export function fillMarkdown(markdown: string, fills: Record<string, string>): string {
  const model = parseMarkdown(markdown)
  let changed = false
  const sections = model.sections.map((section, index) => {
    const text = (fills[`g${index}`] ?? "").replace(/\r\n/g, "\n").trim().slice(0, 4000)
    if (!text || !isGapBody(section.body)) return section
    changed = true
    return { heading: section.heading, body: text }
  })
  if (!changed) return markdown
  const parts = [`# ${model.title}`, ""]
  for (const section of sections) {
    parts.push(`## ${section.heading}`, "", section.body, "")
  }
  return parts.join("\n")
}

function isGapBody(body: string): boolean {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return true
  return lines.every((line) => /^(?:[-*]\s*)?(?:未提供|（未提供）|\[未提供\])[。.]?$/.test(line))
}

export interface SlidePiece {
  role: "subtitle" | "bullet" | "body"
  text: string
}

/** Turn markdown body into slide roles. Markers such as **bold** never reach the slide. */
export function slidePieces(body: string): SlidePiece[] {
  const pieces: SlidePiece[] = []
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
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      const text = cleanInline(heading[1] ?? "")
      if (text) pieces.push({ role: "subtitle", text })
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

function pieceGroups(pieces: SlidePiece[], max = 6): SlidePiece[][] {
  const groups: SlidePiece[][] = []
  let current: SlidePiece[] = []
  for (const piece of pieces) {
    if (current.length >= max) {
      groups.push(current)
      current = []
    }
    current.push(piece)
  }
  if (current.length > 0) groups.push(current)
  return groups.length > 0 ? groups : [pieces]
}

function toRuns(pieces: SlidePiece[]): PptxTextPart[] {
  return pieces.map((piece) => {
    if (piece.role === "subtitle") {
      return {
        text: piece.text,
        options: { fontFace: FONT, fontSize: 18, bold: true, color: "1F4E79", breakLine: true, paraSpaceBefore: 12, paraSpaceAfter: 4 },
      }
    }
    if (piece.role === "bullet") {
      return {
        text: piece.text,
        options: { fontFace: FONT, fontSize: 16, color: "333333", bullet: { indent: 16 }, breakLine: true, paraSpaceAfter: 6 },
      }
    }
    return {
      text: piece.text,
      options: { fontFace: FONT, fontSize: 16, color: "444444", breakLine: true, paraSpaceAfter: 8 },
    }
  })
}

function cleanInline(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

