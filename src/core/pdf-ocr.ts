import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createCanvas } from "@napi-rs/canvas"
import { createWorker } from "tesseract.js"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import { ensureDir } from "../util/paths.js"

export const PDF_EXTRACTOR_TAG = "预处理: unpdf+ocr-v1"

/** 页内可选文字过少时，对该页整页 OCR（常见于表格截图）。 */
const MIN_PAGE_TEXT_CHARS = 80
/** 附录类标题页：文字很少但可能有大图，强制 OCR。 */
const FORCE_OCR_TITLE = /附录|智算资源|资源成本|成本测算|投入产出|测算表/i
const RENDER_SCALE = 2
const MAX_OCR_PAGES = 40
const OCR_RECOGNIZE_MS = 90_000

const TESS_CACHE_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data"), "tesseract-cache")

type PdfHandle = Awaited<ReturnType<typeof openPdfFromBytes>>

async function openPdfFromBytes(data: Uint8Array) {
  return getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise
}

type TessWorker = Awaited<ReturnType<typeof createWorker>>

let ocrWorker: TessWorker | undefined
let ocrWorkerReady: Promise<TessWorker | undefined> | undefined
let ocrDisabled = false

/** PPT 嵌入图只有 PNG/JPEG/WebP/GIF 等位图才 OCR；EMF/WMF 等矢量/元文件会触发 pixRead 崩溃。 */
export function isRasterImageBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  if (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a") return true
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return true
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true // BMP
  return false
}

export function pptMediaOcrCandidate(mediaPath: string, buf: Buffer): boolean {
  const lower = mediaPath.toLowerCase()
  if (/\.(emf|wmf|svg|mp4|m4v|avi|mpeg|mpg)$/i.test(lower)) return false
  return isRasterImageBuffer(buf)
}

async function resetOcrWorker(): Promise<void> {
  ocrWorkerReady = undefined
  const worker = ocrWorker
  ocrWorker = undefined
  if (worker) {
    try {
      await worker.terminate()
    } catch {
      // ignore
    }
  }
}

async function getOcrWorker(): Promise<TessWorker | undefined> {
  if (ocrDisabled) return undefined
  if (ocrWorker) return ocrWorker
  if (!ocrWorkerReady) {
    ocrWorkerReady = (async () => {
      ensureDir(TESS_CACHE_DIR)
      const savedPrefix = process.env.TESSDATA_PREFIX
      delete process.env.TESSDATA_PREFIX
      try {
        const worker = await createWorker(["chi_sim", "eng"], 1, {
          logger: () => {},
          // 默认 errorHandler 会 throw，导致 Node 进程退出；必须吞掉 worker 线程错误。
          errorHandler: () => {},
          cachePath: TESS_CACHE_DIR,
          cacheMethod: "write",
        })
        ocrWorker = worker
        return worker
      } catch {
        ocrDisabled = true
        return undefined
      } finally {
        if (savedPrefix !== undefined) process.env.TESSDATA_PREFIX = savedPrefix
        else delete process.env.TESSDATA_PREFIX
      }
    })()
  }
  return ocrWorkerReady
}

export async function ocrImageBuffer(image: Buffer): Promise<string> {
  if (!isRasterImageBuffer(image)) return ""
  const worker = await getOcrWorker()
  if (!worker) return ""
  try {
    const result = await Promise.race([
      worker.recognize(image),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("OCR timeout")), OCR_RECOGNIZE_MS)
      }),
    ])
    return result.data.text.replace(/\u0000/g, "").trim()
  } catch {
    await resetOcrWorker()
    return ""
  }
}

export async function ocrImageFile(filePath: string): Promise<string> {
  return ocrImageBuffer(fs.readFileSync(filePath))
}

async function ocrPageImage(png: Buffer): Promise<string> {
  return ocrImageBuffer(png)
}

async function pageTextLayer(pdf: PdfHandle, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  return content.items
    .map((item) => ("str" in item ? String(item.str ?? "") : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

async function renderPdfPageToPng(pdf: PdfHandle, pageNumber: number): Promise<Buffer> {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: RENDER_SCALE })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext("2d")
  await page.render({
    canvasContext: context,
    viewport,
    canvas,
  }).promise
  return canvas.toBuffer("image/png")
}

/** 文字层/槽位过少或疑似截图页时，应对整页或嵌入图做 OCR。 */
export function sparsePageNeedsOcr(pageText: string): boolean {
  const trimmed = pageText.replace(/\s+/g, " ").trim()
  if (trimmed.length < MIN_PAGE_TEXT_CHARS) return true
  if (FORCE_OCR_TITLE.test(trimmed)) return true
  // 章节名在文字层，表格在截图里：文字层几乎没数字时也 OCR。
  if (/投入产出|成本测算|智算资源|资源成本/.test(trimmed)) {
    const digits = trimmed.match(/\d+/g) ?? []
    if (digits.length < 4) return true
  }
  return false
}

export interface PdfExtractResult {
  body: string
  ocrPages: number[]
}

/**
 * 按 PDF 真实页码抽文字层；对「少字 / 附录 / 疑似截图页」整页 OCR，合并进正文。
 */
function pageNeedsOcrForReview(layer: string): boolean {
  if (sparsePageNeedsOcr(layer)) return true
  return /附录|竞品|表格|截图|Excel|测算|投入产出|成本|矩阵|数据表/i.test(layer)
}

export async function extractPdfTextWithOcr(
  filePath: string,
  options?: { reviewAudit?: boolean },
): Promise<PdfExtractResult> {
  const data = new Uint8Array(fs.readFileSync(filePath))
  const pdf = await openPdfFromBytes(data)
  const total = pdf.numPages
  const ocrPages: number[] = []
  const parts: string[] = []

  for (let pageNum = 1; pageNum <= total; pageNum += 1) {
    const layer = await pageTextLayer(pdf, pageNum)
    parts.push(`\n--- 第 ${pageNum} 页（文字层）---\n${layer || "（无文字层）"}`)

    if (pageNum > MAX_OCR_PAGES) continue
    const needsOcr = options?.reviewAudit ? pageNeedsOcrForReview(layer) : sparsePageNeedsOcr(layer)
    if (!needsOcr) continue

    try {
      const png = await renderPdfPageToPng(pdf, pageNum)
      const ocr = await ocrPageImage(png)
      if (ocr.length > 0) {
        ocrPages.push(pageNum)
        parts.push(`\n--- 第 ${pageNum} 页【OCR 图片/表格识别】---\n${ocr}`)
      } else {
        parts.push(`\n--- 第 ${pageNum} 页【OCR 无文字】---\n（已渲染该页但未识别到可读文字）`)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      parts.push(`\n--- 第 ${pageNum} 页【OCR 失败】---\n${reason}`)
    }
  }

  return { body: parts.join("\n").trim(), ocrPages }
}

export function pdfSidecarFresh(dest: string, source: string): boolean {
  if (!fs.existsSync(dest) || !fs.existsSync(source)) return false
  if (fs.statSync(dest).mtimeMs < fs.statSync(source).mtimeMs) return false
  try {
    const head = fs.readFileSync(dest, "utf8").slice(0, 400)
    return head.includes(PDF_EXTRACTOR_TAG)
  } catch {
    return false
  }
}
