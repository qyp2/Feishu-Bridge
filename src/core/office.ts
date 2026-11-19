import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { OfficeParser } from "officeparser"
import {
  extractPdfTextWithOcr,
  ocrImageBuffer,
  ocrImageFile,
  pptMediaOcrCandidate,
  pdfSidecarFresh,
  PDF_EXTRACTOR_TAG,
  sparsePageNeedsOcr,
} from "./pdf-ocr.js"

const PPTX_SLOTS_TAG = "预处理: pptx-slots+ocr+fallback-v2"
const PPTX_SLOTS_AUDIT_MARK = "audit-embed-ocr-v4"
const PPTX_SHAPE_TREE_MARK = "shape-tree-v1"
const PPTX_FALLBACK_TAG = "fallback: officeparser-text-v1"
import type { PromptFileAttachment } from "../opencode/types.js"

const require = createRequire(import.meta.url)

interface WordDocument {
  getBody: () => string
}

interface WordExtractorInstance {
  extract: (source: string) => Promise<WordDocument>
}

const WordExtractor = require("word-extractor") as new () => WordExtractorInstance

interface ZipEntry {
  fileName: string
}

interface ZipFile {
  readEntry: () => void
  close: () => void
  openReadStream: (entry: ZipEntry, callback: (error: Error | null, stream: NodeJS.ReadableStream) => void) => void
  on(event: "entry", listener: (entry: ZipEntry) => void): void
  on(event: "end", listener: () => void): void
  on(event: "error", listener: (error: Error) => void): void
}

const yauzl = require("yauzl") as {
  open: (file: string, options: { lazyEntries: boolean }, callback: (error: Error | null, zipfile: ZipFile) => void) => void
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])
const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".log"])
const WORD_EXT = new Set([".doc", ".docx"])
const MAX_BODY_CHARS = 50_000
const MAX_SLIDES = 40
const MAX_RUNS_PER_SLIDE = 8
const MAX_RUNS_PER_SLIDE_AUDIT = 32
const MAX_RUN_CHARS = 80
const MAX_PPT_SUPPLEMENT_CHARS = 20_000
/** 内联给 agent 的 PPT 预处理正文字符上限，避免 prompt 过大。 */
const MAX_PPT_INLINE_CHARS = 12_000

/**
 * Turn uploaded Office files into text the agents are allowed to read.
 * Word becomes a `.txt`. A pptx stays intact and only a slot list is written.
 */
export interface DescribeDocumentsOptions {
  /** 上会审核：对 PPT 表格/截图页更积极做嵌入图 OCR。 */
  reviewAudit?: boolean
  /**
   * 把预处理正文直接内联进提示（只给没有 inbox 读权限的产品介绍机器人用）。
   * 主 Agent 保持原样：只给路径，不内联。
   */
  inlineDocuments?: boolean
}

export async function describeDocuments(
  files: PromptFileAttachment[] | undefined,
  options?: DescribeDocumentsOptions,
): Promise<string> {
  const lines: string[] = []
  let sawWorkbook = false
  for (const file of files ?? []) {
    const uri = file.uri?.trim()
    if (!uri) {
      lines.push(`- ${file.name ?? "附件"}：缺少本地路径，相关内容写「未提供」。`)
      continue
    }
    const filePath = uri.startsWith("file:") ? fileURLToPath(uri) : uri
    const name = file.name ?? path.basename(filePath)
    const ext = path.extname(name || filePath).toLowerCase()
    if (IMAGE_EXT.has(ext)) {
      lines.push(...(await imageLine(name, filePath, options?.inlineDocuments)))
      continue
    }
    if (!fs.existsSync(filePath)) {
      lines.push(`- ${name}：文件不在本地，相关内容写「未提供」。`)
      continue
    }
    if (TEXT_EXT.has(ext)) {
      lines.push(
        `- 正文 ${name}：${filePath}`,
        ...(options?.inlineDocuments ? inlineSidecar(name, filePath, "正文") : []),
      )
      continue
    }
    if (WORD_EXT.has(ext)) {
      lines.push(...(await wordLine(name, filePath, options?.inlineDocuments)))
      continue
    }
    if (ext === ".pptx" || (ext === ".ppt" && isZip(filePath))) {
      lines.push(...(await deckLines(name, filePath, options?.reviewAudit, options?.inlineDocuments)))
      continue
    }
    if (ext === ".pdf") {
      lines.push(...(await pdfLine(name, filePath, options?.reviewAudit, options?.inlineDocuments)))
      continue
    }
    if (ext === ".ppt") {
      lines.push(`- ${name}：旧版 .ppt 无法解析。请改发 .pptx。相关内容写「未提供」。`)
      continue
    }
    if (ext === ".xls") {
      lines.push(`- ${name}：旧版 .xls 无法解析。请改发 .xlsx。相关内容写「未提供」。`)
      continue
    }
    if (ext === ".xlsx" || ext === ".xlsm" || (await isWorkbookFile(filePath))) {
      lines.push(await workbookLine(name, filePath))
      sawWorkbook = true
      continue
    }
    lines.push(`- ${name}：${filePath}。这不是已抽取的文本。不要打开它，相关内容写「未提供」。`)
  }
  if (lines.length === 0) return ""
  return `\n\n${[
    ...(options?.inlineDocuments
      ? [
          "材料已预处理。正文已直接内联在本说明下方（标为「已内联」的代码块），直接使用即可，不必再读文件。",
          "若内联正文被截断，再按标为「正文」或「槽位清单」的路径读取一次。",
        ]
      : ["材料已预处理。业务子 Agent 只读取标为「正文」或「槽位清单」的文本，每份读一次。"]),
    "业务子 Agent 不要读取 .doc、.docx、.ppt、.pptx、.pdf、.xlsx，不要搜索目录。",
    ...(sawWorkbook
      ? [
          "Excel 已抽成同路径的 .txt。个数和占比只能运行下面的计数命令，不要心算，不要通读整表，不要交给子 Agent。",
          "禁止使用 Grep、rg 或正则数行。ripgrep 不支持前瞻，列偏移也不可猜，这样得到的个数无效。Grep 失败后不要换正则重试。",
          `在本机运行 node "${SHEET_TOOL}" count "表格.txt的绝对路径" --where "列名::empty"。`,
          "用户有几个并且条件，这一次命令就写几个 --where。比较写成 列名::contains::文本、列名::not-contains::文本、列名::equals::文本、列名::not-empty。",
          "回复只用这一次输出的 matched 和 ratio。禁止把只满足其中一个条件的数字当成结果。脚本失败就报告错误，不要估算。",
        ]
      : []),
    "模板的 pptx 原路径只交给成稿步骤。成稿不要打开 pptx，把路径传给排版命令。命令会克隆模板的封面、目录、内容页背景和尾页。正文按槽位清单写成带标题的 Markdown。明细用表格；占比写成饼图，对比或趋势写成柱状图。",
    ...lines,
  ].join("\n")}`
}

const MAX_EXTRACT_CHARS = 3_000_000
const SHEET_TOOL = "C:/AGENT_FINAL/feishu_bridge/scripts/sheet.mjs"

interface ExcelCellValue {
  value: unknown
}

interface ExcelRow {
  eachCell(options: { includeEmpty: boolean }, visitor: (cell: ExcelCellValue, col: number) => void): void
}

interface ExcelWorksheet {
  name: string
  eachRow(options: { includeEmpty: boolean }, visitor: (row: ExcelRow, rowNumber: number) => void): void
}

interface ExcelWorkbook {
  worksheets: ExcelWorksheet[]
  xlsx: { readFile(file: string): Promise<void> }
}

/** True when the file is an xlsx/xlsm package, even if the saved name lost `.xlsx`. */
export async function isWorkbookFile(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath) || !isZip(filePath)) return false
  try {
    const entries = await readZipEntries(filePath, (name) => name.replace(/\\/g, "/").toLowerCase() === "xl/workbook.xml")
    return entries.size > 0
  } catch {
    return false
  }
}

/** Write the workbook extract next to the file and return that txt path. */
async function ensureWorkbookExtract(name: string, filePath: string): Promise<string> {
  const dest = `${filePath}.txt`
  if (!isFresh(dest, filePath)) {
    try {
      fs.writeFileSync(dest, await workbookText(name, filePath), "utf8")
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fs.writeFileSync(dest, `来源：${name}\n完整度：抽取失败\n抽取失败：${reason}\n不要读取原始文件。相关内容写「未提供」。\n`, "utf8")
    }
  }
  return dest
}

async function workbookLine(name: string, filePath: string): Promise<string> {
  const dest = await ensureWorkbookExtract(name, filePath)
  const summary = workbookSummary(dest)
  return `- 正文 ${name}：${dest}\n  ${summary}\n  计数命令：node "${SHEET_TOOL}" count "${dest}" --where "列名::empty"`
}

function workbookSummary(dest: string): string {
  const text = fs.readFileSync(dest, "utf8")
  const completeness = /^完整度：(.+)$/m.exec(text)?.[1] ?? "未知"
  const sheets = [...text.matchAll(/^# (.+)$/gm)].map((match) => match[1])
  const rows = /^数据行数：(\d+)$/m.exec(text)?.[1]
  const columns = /^列：(.+)$/m.exec(text)?.[1]?.replace(/\t/g, "、")
  const parts = [`完整度 ${completeness}`]
  if (sheets.length > 0) parts.push(`工作表 ${sheets.join("、")}`)
  if (rows) parts.push(`数据行数 ${rows}`)
  if (columns) parts.push(`列 ${columns}`)
  return parts.join("；")
}

async function workbookText(name: string, filePath: string): Promise<string> {
  const ExcelJS = require("exceljs") as { Workbook: new () => ExcelWorkbook }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const blocks: string[] = []
  let used = 0
  let complete = true
  for (const sheet of workbook.worksheets) {
    const table = renderSheet(sheet)
    const block = [`# ${oneLine(sheet.name) || "Sheet"}`, `数据行数：${table.dataRows}`, `列：${table.headers.join("\t")}`, table.body].join("\n")
    if (used + block.length > MAX_EXTRACT_CHARS) {
      complete = false
      break
    }
    blocks.push(block)
    used += block.length
  }
  return [
    `来源：${name}`,
    "只读本文件，不要读取原始 Excel。第 1 行是表头。空单元格表示缺失。",
    `完整度：${complete ? "完整" : "未完整抽出"}`,
    ...blocks,
    "",
  ].join("\n")
}

function renderSheet(sheet: ExcelWorksheet): { headers: string[]; dataRows: number; body: string } {
  const grid: Map<number, string>[] = []
  let maxCol = 0
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = new Map<number, string>()
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      cells.set(col, formatCell(cell.value))
      if (col > maxCol) maxCol = col
    })
    if ([...cells.values()].some((value) => value.length > 0)) grid.push(cells)
  })
  if (grid.length === 0 || maxCol === 0) return { headers: [], dataRows: 0, body: "" }
  const headerRow = grid[0] ?? new Map<number, string>()
  const used = new Map<string, number>()
  const headers: string[] = []
  for (let col = 1; col <= maxCol; col += 1) {
    const raw = headerRow.get(col) || `列${col}`
    const seen = used.get(raw) ?? 0
    used.set(raw, seen + 1)
    headers.push(seen === 0 ? raw : `${raw} (${seen + 1})`)
  }
  const lines = [headers.join("\t")]
  for (const cells of grid.slice(1)) {
    const values: string[] = []
    for (let col = 1; col <= maxCol; col += 1) values.push(cells.get(col) ?? "")
    lines.push(values.join("\t"))
  }
  return { headers, dataRows: grid.length - 1, body: lines.join("\n") }
}

function formatCell(value: unknown): string {
  if (value == null) return ""
  if (value instanceof Date) return formatDate(value)
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (typeof value === "string") return oneLine(value)
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    if (Array.isArray(record.richText)) {
      return oneLine(record.richText.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")).join(""))
    }
    if ("result" in record) return formatCell(record.result)
    if (typeof record.text === "string") return oneLine(record.text)
    return ""
  }
  return oneLine(String(value))
}

function formatDate(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  if (value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0) return date
  return `${date} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}

function oneLine(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[\t\r\n]+/g, " ").trim()
}

function isZip(filePath: string): boolean {
  const head = Buffer.alloc(2)
  const fd = fs.openSync(filePath, "r")
  try {
    fs.readSync(fd, head, 0, 2, 0)
  } finally {
    fs.closeSync(fd)
  }
  return head.toString("utf8") === "PK"
}

async function pdfLine(name: string, filePath: string, reviewAudit = false, inline = false): Promise<string[]> {
  const dest = `${filePath}.txt`
  if (!pdfSidecarFresh(dest, filePath)) {
    try {
      const { body, ocrPages } = await extractPdfTextWithOcr(filePath, { reviewAudit })
      const ocrNote =
        ocrPages.length > 0 ? `已对第 ${ocrPages.join("、")} 页做 OCR（表格/截图）。\n` : ""
      const clipped = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[以下原文已截断]` : body
      fs.writeFileSync(
        dest,
        `来源：${name}\n${PDF_EXTRACTOR_TAG}\n只读本文件，不要读取原始 PDF。\n${ocrNote}\n${clipped}\n`,
        "utf8",
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fs.writeFileSync(dest, `来源：${name}\n抽取失败：${reason}\n不要读取原始文件。相关内容写「未提供」。\n`, "utf8")
    }
  }
  return [`- 正文 ${name}：${dest}`, ...(inline ? inlineSidecar(name, dest, "正文") : [])]
}

async function imageLine(name: string, filePath: string, inline = false): Promise<string[]> {
  const dest = `${filePath}.txt`
  if (!pdfSidecarFresh(dest, filePath)) {
    try {
      const text = await ocrImageFile(filePath)
      const body = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n\n[以下原文已截断]` : text
      fs.writeFileSync(
        dest,
        `来源：${name}\n${PDF_EXTRACTOR_TAG}\n图片 OCR 正文（只读本文件）：\n\n${body || "（未识别到文字）"}\n`,
        "utf8",
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fs.writeFileSync(dest, `来源：${name}\n图片 OCR 失败：${reason}\n`, "utf8")
    }
  }
  return [`- 正文 ${name}：${dest}`, ...(inline ? inlineSidecar(name, dest, "正文") : [])]
}

async function wordLine(name: string, filePath: string, inline = false): Promise<string[]> {
  const dest = `${filePath}.txt`
  if (!isFresh(dest, filePath)) {
    try {
      const extracted = await new WordExtractor().extract(filePath)
      const text = extracted.getBody().replace(/\u0007/g, "").replace(/\r/g, "\n").trim()
      const body = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n\n[以下原文已截断]` : text
      fs.writeFileSync(dest, `来源：${name}\n只读本文件，不要读取原始 Word 文件。\n\n${body}\n`, "utf8")
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fs.writeFileSync(dest, `来源：${name}\n抽取失败：${reason}\n不要读取原始文件。相关内容写「未提供」。\n`, "utf8")
    }
  }
  return [`- 正文 ${name}：${dest}`, ...(inline ? inlineSidecar(name, dest, "正文") : [])]
}

/**
 * 把预处理正文直接内联进 prompt。
 *
 * 只读产品资料的 agent（如 product-intro）没有会话目录 inbox 的读权限，
 * 只给文件路径会出现"看得到路径、读不到内容"。内联后不再依赖文件读取。
 */
function inlineSidecar(name: string, sidecarPath: string, label: string): string[] {
  try {
    const raw = fs.readFileSync(sidecarPath, "utf8")
    const text = raw.trim()
    if (!text) return []
    const clipped =
      text.length > MAX_PPT_INLINE_CHARS
        ? `${text.slice(0, MAX_PPT_INLINE_CHARS)}\n…（正文已截断，完整内容见上面的${label}路径）`
        : text
    return ["", `#### 【${name} 预处理正文（${label}，已内联，直接使用，不要再去读文件）】`, "```text", clipped, "```"]
  } catch (error) {
    return [
      `- ${label}读取失败（内联失败，可尝试按上面的路径读取）：${error instanceof Error ? error.message : String(error)}`,
    ]
  }
}

async function deckLines(name: string, filePath: string, reviewAudit = false, inline = false): Promise<string[]> {
  const dest = `${filePath}.slots.md`
  if (!pptSidecarFresh(dest, filePath, reviewAudit)) {
    try {
      const [slides, layouts, supplementText] = await Promise.all([
        pptxSlotsWithOcr(filePath, reviewAudit),
        pptxLayouts(filePath),
        pptxSupplementText(filePath),
      ])
      fs.writeFileSync(dest, renderSlots(name, filePath, slides, layouts, reviewAudit, supplementText), "utf8")
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fs.writeFileSync(
        dest,
        `来源模板：${filePath}\n抽取槽位失败：${reason}\n不要读取 pptx。模板原文件已保留。正文槽位写「未提供」。\n`,
        "utf8",
      )
    }
  }
  return [
    `- 模板原文件（不要读取）${name}：${filePath}`,
    `- 槽位清单 ${name}：${dest}`,
    ...(inline ? inlineSidecar(name, dest, "槽位清单") : []),
  ]
}

function isFresh(dest: string, source: string): boolean {
  if (!fs.existsSync(dest)) return false
  return fs.statSync(dest).mtimeMs >= fs.statSync(source).mtimeMs
}

function pptSidecarFresh(dest: string, source: string, reviewAudit = false): boolean {
  if (!isFresh(dest, source)) return false
  try {
    const head = fs.readFileSync(dest, "utf8").slice(0, 400)
    if (!head.includes(PPTX_SLOTS_TAG)) return false
    if (!head.includes(PPTX_FALLBACK_TAG)) return false
    if (reviewAudit && !head.includes(PPTX_SLOTS_AUDIT_MARK)) return false
    if (reviewAudit && !head.includes(PPTX_SHAPE_TREE_MARK)) return false
    return true
  } catch {
    return false
  }
}

type PptxSlideExtract = {
  index: number
  runs: string[]
  ocrText: string[]
  tableText: string[]
  parseFlags: string[]
}

function renderSlots(
  name: string,
  filePath: string,
  slides: PptxSlideExtract[],
  layouts: string[],
  reviewAudit = false,
  supplementText = "",
): string {
  const pages = slides.length === 0 ? ["（未识别到页面文字。槽位写「未提供」。）"] : slides.map((s) => renderSlide(s, reviewAudit))
  const layoutBlock = layouts.length === 0 ? ["（未识别到版式）"] : layouts.map((layout) => `- ${layout}`)
  const supplementBlock =
    supplementText.trim().length > 0
      ? [
          "",
          "## 开源补强正文",
          `${PPTX_FALLBACK_TAG}`,
          "下面这段是通过开源项目 officeparser 提取的整份 PPT 正文，用来补强复杂图文混排页、备注页和部分漏抽文本。若与页级槽位冲突，以页级槽位、原生表格抽取和 OCR 为准。",
          "```text",
          supplementText.trim(),
          "```",
        ]
      : []
  return [
    `来源模板：${name}`,
    PPTX_SLOTS_TAG,
    PPTX_FALLBACK_TAG,
    ...(reviewAudit ? [PPTX_SLOTS_AUDIT_MARK, PPTX_SHAPE_TREE_MARK] : []),
    `模板原文件：${filePath}`,
    ...(reviewAudit
      ? [
          "解析标记：各页可能含 HTML 注释 `<!-- parse-flags: ... -->`。含 parse-maybe-incomplete / table-xml-unextracted / embed-ocr-empty 时，审核不得对相关 criteria 直接判「缺失」，应判「待确认」并建议人工打开原稿核对。",
        ]
      : []),
    "本文件只是槽位清单。不要读取 pptx 原文件。",
    "成稿时按下面的版式写 Markdown：每个小节一个标题。桥接会据此生成真正的 pptx、docx 或 pdf，并发到飞书。",
    "不要读取或改写模板原文件。",
    "",
    "## 版式",
    ...layoutBlock,
    "",
    "## 示例页",
    ...pages,
    ...supplementBlock,
    "",
  ].join("\n")
}

function renderSlide(slide: PptxSlideExtract, reviewAudit: boolean): string {
  const flagLine =
    reviewAudit && slide.parseFlags.length > 0
      ? [`<!-- parse-flags: ${slide.parseFlags.join(", ")} -->`]
      : []
  const tableBlock =
    slide.tableText && slide.tableText.length > 0
      ? [
          "",
          "#### 【PPT 原生表格抽取】",
          ...slide.tableText.map((block) => `\n${block}\n`),
        ]
      : []
  const ocrBlock =
    slide.ocrText && slide.ocrText.length > 0
      ? [
          "",
          "#### 【OCR 图片/表格识别】",
          ...slide.ocrText.map((block) => {
            const clipped = block.length > 4000 ? `${block.slice(0, 4000)}\n…（OCR 已截断）` : block
            return `\`\`\`\n${clipped}\n\`\`\``
          }),
        ]
      : []
  if (slide.runs.length === 0) {
    return [`## 第 ${slide.index} 页`, ...flagLine, "- （本页无文字槽位）", ...tableBlock, ...ocrBlock].join("\n")
  }
  return [`## 第 ${slide.index} 页`, ...flagLine, ...slide.runs.map((run) => `- ${run}`), ...tableBlock, ...ocrBlock].join(
    "\n",
  )
}

function pptMediaPathFromRelTarget(target: string): string {
  const normalized = target.replace(/\\/g, "/").replace(/^\.\.\//, "")
  return normalized.startsWith("ppt/") ? normalized : `ppt/${normalized}`
}

function embedIdsFromSlideXml(xml: string): string[] {
  const ids = new Set<string>()
  for (const match of xml.matchAll(/r:embed="([^"]+)"/g)) ids.add(match[1] ?? "")
  return [...ids].filter(Boolean)
}

function relsTargetById(relsXml: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) {
    map.set(match[1] ?? "", match[2] ?? "")
  }
  return map
}

const REVIEW_OCR_HINT = /表|图|截图|附录|测算|占比|投入|成本|矩阵|数据|图表/i

function slideNeedsEmbedOcr(layerText: string, thorough: boolean): boolean {
  if (sparsePageNeedsOcr(layerText)) return true
  if (!thorough) return false
  const compact = layerText.replace(/\s+/g, " ").trim()
  if (compact.length < 120) return true
  if (REVIEW_OCR_HINT.test(compact)) return true
  const digits = compact.match(/\d+/g) ?? []
  if (/测算|投入|成本|表/.test(compact) && digits.length < 4) return true
  return false
}

function dedupeMarkdownTables(blocks: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const block of blocks) {
    const key = block.replace(/\s+/g, " ").trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(block)
  }
  return out
}

function extractSlideTables(xml: string): string[] {
  const out: string[] = []
  for (const tbl of xml.matchAll(/<a:tbl[\s\S]*?<\/a:tbl>/g)) {
    const rows: string[][] = []
    for (const tr of tbl[0].matchAll(/<a:tr[^>]*>([\s\S]*?)<\/a:tr>/g)) {
      const trBody = tr[1]
      if (!trBody) continue
      const cells: string[] = []
      for (const tc of trBody.matchAll(/<a:tc[\s\S]*?<\/a:tc>/g)) {
        const parts = [...tc[0].matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1] ?? "").trim())
        cells.push(parts.join(" ").replace(/\s+/g, " ").trim())
      }
      if (cells.some((c) => c.length > 0)) rows.push(cells)
    }
    if (rows.length === 0) continue
    const width = Math.max(...rows.map((r) => r.length))
    const norm = (row: string[]) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]
    const head = norm(rows[0]!)
    const lines = [
      `| ${head.join(" | ")} |`,
      `| ${head.map(() => "---").join(" | ")} |`,
      ...rows.slice(1).map((row) => `| ${norm(row).join(" | ")} |`),
    ]
    out.push(lines.join("\n"))
  }
  return out
}

/** 按 shape 边界（sp / grpSp / graphicFrame）聚合文本，便于组合文本框与表格区单独成条。 */
function xmlTextsByShape(xml: string, maxRuns: number, maxChars: number): string[] {
  const chunks = xml.split(/<\/p:(?:sp|grpSp|graphicFrame)>/i)
  const runs: string[] = []
  for (const chunk of chunks) {
    const parts = [...chunk.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
      .map((m) => decodeXml(m[1] ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
    if (parts.length === 0) continue
    const text = parts.join(" ")
    runs.push(text.length > maxChars ? `${text.slice(0, maxChars)}…` : text)
    if (runs.length >= maxRuns) break
  }
  if (runs.length > 0) return runs
  return xmlTexts(xml).slice(0, maxRuns)
}

function extractTablesByShapeChunks(xml: string): string[] {
  const chunks = xml.split(/<\/p:(?:sp|grpSp|graphicFrame)>/i)
  const tables: string[] = []
  for (const chunk of chunks) {
    if (!/<a:tbl/i.test(chunk)) continue
    tables.push(...extractSlideTables(chunk))
  }
  return tables
}

function computeSlideParseFlags(input: {
  xml: string
  runs: string[]
  tableText: string[]
  ocrText: string[]
  thorough: boolean
  triedEmbedOcr: boolean
}): string[] {
  if (!input.thorough) return []
  const flags: string[] = []
  const layer = [...input.runs, ...input.tableText, ...input.ocrText].join(" ")
  const hasTblXml = /<a:tbl/i.test(input.xml)
  const hasGrp = /<p:grpSp/i.test(input.xml)
  if (hasTblXml && input.tableText.length === 0) flags.push("table-xml-unextracted")
  if (hasGrp) flags.push("group-shape-present")
  if (input.runs.length <= 2 && input.tableText.length === 0 && (hasTblXml || hasGrp || REVIEW_OCR_HINT.test(input.xml))) {
    flags.push("parse-maybe-incomplete")
  }
  if (input.triedEmbedOcr && input.ocrText.length === 0) flags.push("embed-ocr-empty")
  if (REVIEW_OCR_HINT.test(layer) && (layer.match(/\d+/g) ?? []).length < 2 && input.tableText.length === 0) {
    flags.push("sparse-numeric-hint")
  }
  return flags
}

function slideHasMediaEmbed(xml: string, rels: Map<string, string> | undefined): boolean {
  if (!rels) return false
  for (const embedId of embedIdsFromSlideXml(xml)) {
    const target = rels.get(embedId)
    if (target && /media\//i.test(target)) return true
  }
  return false
}

async function pptxSlotsWithOcr(filePath: string, thorough = false): Promise<PptxSlideExtract[]> {
  const xmlByName = await readZipEntries(filePath, (entryName) => /^ppt\/slides\/slide\d+\.xml$/i.test(entryName))
  const relsByName = await readZipEntries(filePath, (entryName) =>
    /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/i.test(entryName),
  )
  const relsBySlide = new Map<number, Map<string, string>>()
  for (const [entryName, relsXml] of relsByName.entries()) {
    const index = Number(entryName.match(/slide(\d+)\.xml\.rels/i)?.[1] ?? 0)
    if (index > 0) relsBySlide.set(index, relsTargetById(relsXml))
  }

  const slides = [...xmlByName.entries()]
    .map(([entryName, xml]) => ({
      index: Number(entryName.match(/slide(\d+)\.xml/i)?.[1] ?? 0),
      runs: thorough
        ? xmlTextsByShape(xml, MAX_RUNS_PER_SLIDE_AUDIT, MAX_RUN_CHARS)
        : xmlTexts(xml).slice(0, MAX_RUNS_PER_SLIDE),
      xml,
      ocrText: [] as string[],
      tableText: [] as string[],
      parseFlags: [] as string[],
    }))
    .filter((slide) => slide.index > 0)
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_SLIDES)

  const mediaByPath = await readZipBufferEntries(filePath, (entryName) => /^ppt\/media\//i.test(entryName))

  for (const slide of slides) {
    const layerText = slide.runs.join(" ")
    const rels = relsBySlide.get(slide.index)
    let triedEmbedOcr = false
    if (thorough) {
      slide.tableText = dedupeMarkdownTables([
        ...extractSlideTables(slide.xml),
        ...extractTablesByShapeChunks(slide.xml),
      ])
    }
    const ocrAllEmbeds = thorough && slideHasMediaEmbed(slide.xml, rels)
    const ocrSomeEmbeds = !ocrAllEmbeds && slideNeedsEmbedOcr(layerText, thorough)
    if (!ocrAllEmbeds && !ocrSomeEmbeds) {
      slide.parseFlags = computeSlideParseFlags({
        xml: slide.xml,
        runs: slide.runs,
        tableText: slide.tableText,
        ocrText: slide.ocrText,
        thorough,
        triedEmbedOcr,
      })
      continue
    }
    if (!rels) {
      slide.parseFlags = computeSlideParseFlags({
        xml: slide.xml,
        runs: slide.runs,
        tableText: slide.tableText,
        ocrText: slide.ocrText,
        thorough,
        triedEmbedOcr,
      })
      continue
    }
    triedEmbedOcr = true
    for (const embedId of embedIdsFromSlideXml(slide.xml)) {
      const target = rels.get(embedId)
      if (!target || !/media\//i.test(target)) continue
      const mediaPath = pptMediaPathFromRelTarget(target)
      const buf = mediaByPath.get(mediaPath)
      if (!buf || buf.length === 0) continue
      if (!pptMediaOcrCandidate(mediaPath, buf)) continue
      const ocr = await ocrImageBuffer(buf)
      if (ocr.length > 0) slide.ocrText.push(ocr)
    }
    slide.parseFlags = computeSlideParseFlags({
      xml: slide.xml,
      runs: slide.runs,
      tableText: slide.tableText,
      ocrText: slide.ocrText,
      thorough,
      triedEmbedOcr,
    })
  }

  return slides.map(({ index, runs, ocrText, tableText, parseFlags }) => ({
    index,
    runs,
    ocrText,
    tableText,
    parseFlags,
  }))
}

async function pptxSupplementText(filePath: string): Promise<string> {
  try {
    const ast = (await OfficeParser.parseOffice(filePath, {
      extractAttachments: false,
      ignoreSlideMasters: true,
      includeRawContent: false,
    })) as {
      to: (format: string, config?: unknown) => Promise<{ value: unknown }>
    }
    const result = await ast.to("text", {
      includeImages: "none",
      textConfig: {
        preserveLayout: false,
        renderNotes: true,
        pageSeparator: "\n\n",
      },
    })
    const value = normalizePptSupplementText(result.value)
    if (!value) return ""
    return value.length > MAX_PPT_SUPPLEMENT_CHARS ? `${value.slice(0, MAX_PPT_SUPPLEMENT_CHARS)}\n\n[以下补强正文已截断]` : value
  } catch {
    return ""
  }
}

function normalizePptSupplementText(value: unknown): string {
  if (typeof value !== "string") return ""
  return value
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

async function pptxLayouts(filePath: string): Promise<string[]> {
  const xmlByName = await readZipEntries(filePath, (entryName) =>
    /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(entryName),
  )
  return [...xmlByName.entries()]
    .map(([entryName, xml]) => ({
      index: Number(entryName.match(/slideLayout(\d+)\.xml/i)?.[1] ?? 0),
      name: decodeXml(xml.match(/<p:cSld[^>]*\sname="([^"]*)"/)?.[1] ?? "").trim(),
    }))
    .filter((layout) => layout.index > 0 && layout.name.length > 0)
    .sort((a, b) => a.index - b.index)
    .map((layout) => layout.name)
}

function xmlTexts(xml: string): string[] {
  const runs: string[] = []
  for (const match of xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)) {
    const text = decodeXml(match[1] ?? "").replace(/\s+/g, " ").trim()
    if (!text) continue
    runs.push(text.length > MAX_RUN_CHARS ? `${text.slice(0, MAX_RUN_CHARS)}…` : text)
  }
  return runs
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
}

function readZipBufferEntries(filePath: string, include: (name: string) => boolean): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error("无法打开压缩包"))
        return
      }
      const found = new Map<string, Buffer>()
      const fail = (reason: Error) => {
        zipfile.close()
        reject(reason)
      }
      zipfile.on("error", fail)
      zipfile.on("end", () => resolve(found))
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName) || !include(entry.fileName)) {
          zipfile.readEntry()
          return
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zipfile.readEntry()
            return
          }
          const chunks: Buffer[] = []
          stream.on("data", (chunk: Buffer) => chunks.push(chunk))
          stream.on("error", () => zipfile.readEntry())
          stream.on("end", () => {
            found.set(entry.fileName, Buffer.concat(chunks))
            zipfile.readEntry()
          })
        })
      })
      zipfile.readEntry()
    })
  })
}

function readZipEntries(filePath: string, include: (name: string) => boolean): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error("无法打开压缩包"))
        return
      }
      const found = new Map<string, string>()
      const fail = (reason: Error) => {
        zipfile.close()
        reject(reason)
      }
      zipfile.on("error", fail)
      zipfile.on("end", () => resolve(found))
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName) || !include(entry.fileName)) {
          zipfile.readEntry()
          return
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zipfile.readEntry()
            return
          }
          const chunks: Buffer[] = []
          stream.on("data", (chunk: Buffer) => chunks.push(chunk))
          stream.on("error", () => zipfile.readEntry())
          stream.on("end", () => {
            found.set(entry.fileName, Buffer.concat(chunks).toString("utf8"))
            zipfile.readEntry()
          })
        })
      })
      zipfile.readEntry()
    })
  })
}
