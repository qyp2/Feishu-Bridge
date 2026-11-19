import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { PromptFileAttachment } from "../opencode/types.js"
import { describeDocuments } from "../core/office.js"
import { ensureDir, safeFileName, safeSegment } from "../util/paths.js"
import { readJson } from "../util/jsonfile.js"

const REVIEW_ROOT = "review-meeting"

export function reviewMeetingRoot(storageDir: string): string {
  return path.join(storageDir, REVIEW_ROOT)
}

/** 用户意图是「审核上会材料」，而不是「写商业计划书/请示」。 */
export function isReviewMeetingAudit(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  const writeIntent = /(?:写|撰写|生成|制作|导出|成稿|帮我做|帮我写).{0,12}(?:商业计划|计划书|请示|PPT|ppt)/.test(t)
  if (writeIntent) return false
  const auditIntent = [
    /上会材料|上会审核|上会预审|上会前|上会把关|开发上会|能否上会|可否上会|能不能上会|可以上会吗|能上吗/,
    /评审材料|评审会材料|开发评审|产品评审|规划评审|专题办公|产品规划及开发评审/,
    /材料.{0,6}(审核|审阅|审查|检查|预审|复核|把关|核对|过一遍)/,
    /(?:帮我|请).{0,4}(审|查|看|检).{0,6}(材料|上会|评审)/,
    /(?:审|查|检|看).{0,4}(?:一下|下).{0,4}(?:材料|上会|评审)/,
    /材料.{0,4}(齐备|齐不齐|全不全|够不够|完整吗|全吗)/,
    /(?:还|)缺.{0,4}什么材料|漏.{0,4}材料|待补充|材料清单/,
    /对照.{0,6}清单|按清单.{0,4}(审|查|检查)/,
    /齐备性|材料预审|PM材料|提交材料.{0,4}(审|查)/,
  ]
  return auditIntent.some((pattern) => pattern.test(t))
}

interface CurrentChecklist {
  version?: string
  path?: string
}

interface CaseManifest {
  caseId: string
  checklistVersion: string
  checklistPath: string
  manifestPath: string
  templatesRoot: string
  createdAt: string
  chatId: string
  openId?: string
  submissions: Array<{ name: string; originalPath: string; textPath?: string }>
}

function resolveFilePath(uri: string): string {
  return uri.startsWith("file:") ? fileURLToPath(uri) : uri
}

/**
 * 上会审核注入：describeDocuments(OCR/槽位) → 复制 submission → case.json → A0 路由 A24+S46。
 * 与「文档制作」独立；成稿链不走此块。
 */
export async function buildReviewMeetingPromptBlock(
  storageDir: string,
  chatId: string,
  openId: string | undefined,
  files: PromptFileAttachment[],
): Promise<string> {
  const root = reviewMeetingRoot(storageDir)
  const checklistDir = path.join(root, "checklist")
  const current = readJson<CurrentChecklist>(path.join(checklistDir, "CURRENT.json"), {})
  const checklistRel = current.path ?? "checklist/v1.json"
  const checklistPath = path.join(root, checklistRel)
  if (!fs.existsSync(checklistPath)) {
    return "【上会材料审核】清单未就绪，请管理员导入 checklist/v1.json。"
  }

  const caseId = `${Date.now()}_${safeSegment(chatId)}`
  const caseDir = ensureDir(path.join(root, "cases", caseId))
  const submissionDir = ensureDir(path.join(caseDir, "submission"))

  const docNote = files.length > 0 ? await describeDocuments(files, { reviewAudit: true }) : ""
  const textPaths: string[] = []
  const submissions: CaseManifest["submissions"] = []

  for (const file of files) {
    const originalPath = resolveFilePath(file.uri)
    const name = file.name ?? path.basename(originalPath)
    const destOriginal = path.join(submissionDir, safeFileName(name) || "file")
    if (fs.existsSync(originalPath)) {
      fs.copyFileSync(originalPath, destOriginal)
    }
    const siblingTxt = `${originalPath}.txt`
    const siblingSlots = `${originalPath}.slots.md`
    let textPath: string | undefined
    if (fs.existsSync(siblingTxt)) {
      textPath = path.join(submissionDir, `${safeSegment(name)}.txt`)
      fs.copyFileSync(siblingTxt, textPath)
      textPaths.push(textPath)
    } else if (/\.(txt|md)$/i.test(originalPath)) {
      textPath = path.join(submissionDir, safeSegment(name))
      if (path.resolve(textPath) !== path.resolve(originalPath) && fs.existsSync(originalPath)) {
        fs.copyFileSync(originalPath, textPath)
      } else {
        textPath = originalPath
      }
      textPaths.push(textPath)
    } else if (fs.existsSync(siblingSlots)) {
      textPath = path.join(submissionDir, `${safeSegment(name)}.slots.md`)
      fs.copyFileSync(siblingSlots, textPath)
      textPaths.push(textPath)
    }
    submissions.push({ name, originalPath: destOriginal, textPath })
  }

  const manifest: CaseManifest = {
    caseId,
    checklistVersion: current.version ?? "v1",
    checklistPath,
    manifestPath: path.join(root, "manifest.json"),
    templatesRoot: path.join(root, "templates"),
    createdAt: new Date().toISOString(),
    chatId,
    openId,
    submissions,
  }
  fs.writeFileSync(path.join(caseDir, "case.json"), JSON.stringify(manifest, null, 2), "utf8")

  const templateRoles = [
    "requirement-survey-template → M1 产品需求报告",
    "product-review-meeting-deck-template → M2 产品商业计划书",
    "product-standardization-request-template → M3 产品化请示",
  ]

  const lines = [
    "【上会材料审核 · 桥接上下文】",
    "请 A0 路由为：任务类型 review-meeting | 技能 s46-review-meeting-audit | 正文 Agent pm-a24-review-meeting。",
    "这是直接回复任务：不要调用 pm-a61-deliverable，不要生成文件，不要 [[send-file]]。",
    "投递：A24 按 S46 输出「结论→下一步→P0/P1→已达标（业务短句）→问题明细→材料映射」**一份**；A0 原样转发一次，禁止复述、禁止第二条消息重复表格。",
    "内部仍须判齐 M1-C1…M3-C9；用户可见文字禁止 Mx/Mx-Cn，用「需求报告/商业计划书/请示」+ 检查项业务说法。",
    "预处理说明：PPT 按 shape 树抽取文本与表格（Markdown），并对嵌入图做 OCR（上会加强模式）；各页可能有 `<!-- parse-flags: ... -->`。PDF 附录/竞品/测算类页会整页 OCR。审核时必查表格/OCR 块与 parse-flags；有 parse-flags 时不得直接判缺失，用「待确认」。判缺失前按 S46 做关键词模糊反向验证。仅交 M2 时 M1/M3 缺失指独立文件未随附，非 PPT 内容缺陷（见 S46 概要）。",
    `冻结清单：${checklistPath}`,
    `模板根目录（对照用）：${manifest.templatesRoot}`,
    "模板角色：" + templateRoles.join("；"),
    `本次审核档案：${caseDir}`,
  ]
  if (textPaths.length > 0) {
    lines.push("PM 本次材料正文（语义审核只读这些路径，每份读一次）：")
    for (const p of textPaths) lines.push(`- ${p}`)
  } else if (files.length === 0) {
    lines.push("本轮未收到附件。请提示 PM 在对话中上传 Word/PPT/PDF/Markdown 后再审。")
  } else {
    lines.push("附件未能抽出正文。请 PM 改发可解析格式或重新上传。")
  }
  if (docNote.trim()) {
    lines.push("", "预处理摘要：", docNote.trim())
  }
  return lines.join("\n")
}
