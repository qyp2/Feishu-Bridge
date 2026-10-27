import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { extractText, getDocumentProxy } from "unpdf"
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
const MAX_RUN_CHARS = 80

/**
 * Turn uploaded Office files into text the agents are allowed to read.
 * Word becomes a `.txt`. A pptx stays intact and only a slot list is written.
 */
export async function describeDocuments(files: PromptFileAttachment[] | undefined): Promise<string> {
  const lines: string[] = []
  for (const file of files ?? []) {
    const filePath = file.uri.startsWith("file:") ? fileURLToPath(file.uri) : file.uri
    const name = file.name ?? path.basename(filePath)
    const ext = path.extname(name || filePath).toLowerCase()
    if (IMAGE_EXT.has(ext)) continue
    if (!fs.existsSync(filePath)) {
      lines.push(`- ${name}：文件不在本地，相关内容写「未提供」。`)
      continue
    }
    if (TEXT_EXT.has(ext)) {
      lines.push(`- 正文 ${name}：${filePath}`)
      continue
    }
    if (WORD_EXT.has(ext)) {
      lines.push(await wordLine(name, filePath))
      continue
    }
    if (ext === ".pptx" || (ext === ".ppt" && isZip(filePath))) {
      lines.push(...(await deckLines(name, filePath)))
      continue
    }
    if (ext === ".pdf") {
      lines.push(await pdfLine(name, filePath))
      continue
    }
    if (ext === ".ppt") {
      lines.push(`- ${name}：旧版 .ppt 无法解析。请改发 .pptx。相关内容写「未提供」。`)
      continue
    }
    lines.push(`- ${name}：${filePath}。这不是已抽取的文本。不要打开它，相关内容写「未提供」。`)
  }
  if (lines.length === 0) return ""
  return [
    "",
    "材料已预处理。业务子 Agent 只读取标为「正文」或「槽位清单」的文本，每份读一次。",
    "业务子 Agent 不要读取 .doc、.docx、.ppt、.pptx、.pdf，不要搜索目录。",
    "模板的 pptx 原路径只交给成稿步骤。成稿不要打开 pptx，把路径传给排版命令。命令会克隆模板的封面、目录、内容页背景和尾页。正文按槽位清单写成带标题的 Markdown。明细用表格；占比写成饼图，对比或趋势写成柱状图。",
    ...lines,
  ].join("\n")
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

async function pdfLine(name: string, filePath: string): Promise<string> {
  const dest = `${filePath}.txt`
  if (!isFresh(dest, filePath)) {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(filePath)))
      const extracted = await extractText(pdf, { mergePages: true })
      const text = extracted.text.replace(/\u0000/g, "").trim()
      const body = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n\n[以下原文已截断]` : text
      fs.writeFileSync(dest, `来源：${name}\n只读本文件，不要读取原始 PDF。\n\n${body}\n`, "utf8")
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fs.writeFileSync(dest, `来源：${name}\n抽取失败：${reason}\n不要读取原始文件。相关内容写「未提供」。\n`, "utf8")
    }
  }
  return `- 正文 ${name}：${dest}`
}

async function wordLine(name: string, filePath: string): Promise<string> {
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
  return `- 正文 ${name}：${dest}`
}

async function deckLines(name: string, filePath: string): Promise<string[]> {
  const dest = `${filePath}.slots.md`
  if (!isFresh(dest, filePath)) {
    try {
      const slides = await pptxSlots(filePath)
      const layouts = await pptxLayouts(filePath)
      fs.writeFileSync(dest, renderSlots(name, filePath, slides, layouts), "utf8")
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fs.writeFileSync(
        dest,
        `来源模板：${filePath}\n抽取槽位失败：${reason}\n不要读取 pptx。模板原文件已保留。正文槽位写「未提供」。\n`,
        "utf8",
      )
    }
  }
  return [`- 模板原文件（不要读取）${name}：${filePath}`, `- 槽位清单 ${name}：${dest}`]
}

function isFresh(dest: string, source: string): boolean {
  if (!fs.existsSync(dest)) return false
  return fs.statSync(dest).mtimeMs >= fs.statSync(source).mtimeMs
}

function renderSlots(
  name: string,
  filePath: string,
  slides: { index: number; runs: string[] }[],
  layouts: string[],
): string {
  const pages = slides.length === 0 ? ["（未识别到页面文字。槽位写「未提供」。）"] : slides.map(renderSlide)
  const layoutBlock = layouts.length === 0 ? ["（未识别到版式）"] : layouts.map((layout) => `- ${layout}`)
  return [
    `来源模板：${name}`,
    `模板原文件：${filePath}`,
    "本文件只是槽位清单。不要读取 pptx 原文件。",
    "成稿时按下面的版式写 Markdown：每个小节一个标题。桥接会据此生成真正的 pptx、docx 或 pdf，并发到飞书。",
    "不要读取或改写模板原文件。",
    "",
    "## 版式",
    ...layoutBlock,
    "",
    "## 示例页",
    ...pages,
    "",
  ].join("\n")
}

function renderSlide(slide: { index: number; runs: string[] }): string {
  if (slide.runs.length === 0) return `## 第 ${slide.index} 页\n- （本页无文字槽位）`
  return [`## 第 ${slide.index} 页`, ...slide.runs.map((run) => `- ${run}`)].join("\n")
}

async function pptxSlots(filePath: string): Promise<{ index: number; runs: string[] }[]> {
  const xmlByName = await readZipEntries(filePath, (entryName) => /^ppt\/slides\/slide\d+\.xml$/i.test(entryName))
  return [...xmlByName.entries()]
    .map(([entryName, xml]) => ({
      index: Number(entryName.match(/slide(\d+)\.xml/i)?.[1] ?? 0),
      runs: xmlTexts(xml).slice(0, MAX_RUNS_PER_SLIDE),
    }))
    .filter((slide) => slide.index > 0)
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_SLIDES)
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
