import fs from "node:fs"
import path from "node:path"
import { ensureDir } from "../util/paths.js"
import {
  StudioApiError,
  StudioClient,
  type StudioCardType,
  type StudioJob,
  type StudioMe,
  type StudioTemplateDetail,
  type StudioTemplateField,
  type StudioTemplateSummary,
} from "./client.js"
import { StudioAccountStore, type StudioAccount } from "./accounts.js"
import type { StudioKind } from "../feishu/cards.js"

export interface StudioRunInput {
  kind: StudioKind
  prompt?: string
  product?: string
  channel?: string
  language?: string
  words?: string
  scene?: string
  selling?: string
  platform?: string
  tone?: string
}

export interface StudioRunResult {
  job: StudioJob
  template: StudioTemplateDetail
  pointsLeft?: number
  imageFiles: string[]
}

/** 登录前暂存的创作意图：登录成功后继续引导描述或直接生成。 */
export interface StudioPendingIntent {
  kind: StudioKind
  prompt?: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 创作工作台专用服务：登录、拉模板、提交任务、轮询。 */
export class StudioService {
  readonly client: StudioClient
  readonly accounts: StudioAccountStore
  private readonly cacheDir: string
  private readonly pendingByOpenId = new Map<string, StudioPendingIntent>()

  constructor(storageDir: string, baseUrl?: string) {
    this.client = new StudioClient(baseUrl)
    this.accounts = new StudioAccountStore(storageDir)
    this.cacheDir = ensureDir(path.join(storageDir, "studio-cache"))
  }

  account(openId: string): StudioAccount | undefined {
    return this.accounts.get(openId)
  }

  /** 清除本地绑定的玉树 token，下次创作需重新验证码登录。 */
  logout(openId: string): void {
    this.accounts.clear(openId)
    this.pendingByOpenId.delete(openId.trim())
  }

  setPending(openId: string, intent: StudioPendingIntent): void {
    const id = openId.trim()
    if (!id) return
    this.pendingByOpenId.set(id, intent)
  }

  takePending(openId: string): StudioPendingIntent | undefined {
    const id = openId.trim()
    if (!id) return undefined
    const intent = this.pendingByOpenId.get(id)
    if (intent) this.pendingByOpenId.delete(id)
    return intent
  }

  async sendSms(mobileRaw: string): Promise<{ mobile: string; areaCode: string }> {
    const parsed = parseMobile(mobileRaw)
    if (!parsed) throw new StudioApiError(40000, "请输入有效手机号（内地 11 位或香港 8 位）。")
    await this.client.sendSms(parsed.mobile, parsed.areaCode)
    return parsed
  }

  async login(openId: string, mobileRaw: string, code: string): Promise<{ account: StudioAccount; me: StudioMe }> {
    const parsed = parseMobile(mobileRaw)
    if (!parsed) throw new StudioApiError(40000, "请输入有效手机号（内地 11 位或香港 8 位）。")
    if (!/^\d{4,8}$/.test(code.trim())) throw new StudioApiError(40000, "请输入短信验证码。")
    const token = await this.client.login(parsed.mobile, code.trim(), parsed.areaCode)
    const account: StudioAccount = {
      openId,
      mobile: parsed.mobile,
      areaCode: parsed.areaCode,
      accessToken: token.access_token,
      updatedAt: Date.now(),
    }
    this.accounts.set(account)
    const me = await this.client.me(account.accessToken).catch(() => ({} as StudioMe))
    return { account, me }
  }

  async me(openId: string): Promise<StudioMe | undefined> {
    const account = this.accounts.get(openId)
    if (!account) return undefined
    try {
      return await this.client.me(account.accessToken)
    } catch (error) {
      if (error instanceof StudioApiError && (error.code === 40100 || error.code === 40101 || error.code === 401)) {
        this.accounts.clear(openId)
        return undefined
      }
      throw error
    }
  }

  async run(openId: string, input: StudioRunInput): Promise<StudioRunResult> {
    const account = this.accounts.get(openId)
    if (!account) throw new StudioApiError(40100, "尚未绑定网页端账号，请先发送「验证码登录」。")

    const cardType = cardTypeOf(input.kind)
    const templates = await this.client.listTemplates(account.accessToken, cardType)
    const picked = pickTemplate(templates, input.kind)
    if (!picked) throw new StudioApiError(40400, `暂无可用的${kindLabel(input.kind)}模板，请稍后再试或联系管理员配置。`)

    const detail = await this.client.getTemplate(account.accessToken, picked.id)
    const fields = buildFields(detail, input)
    const job = await this.client.createJob(account.accessToken, {
      template_id: detail.id,
      fields,
      request_id: `feishu-${openId.slice(-8)}-${Date.now()}`,
    })
    const finished = await this.pollJob(account.accessToken, job.job_id)
    if (!finished.job_id) finished.job_id = job.job_id

    const imageFiles: string[] = []
    if (finished.status === "succeeded") {
      for (const [index, image] of (finished.images ?? []).entries()) {
        if (!image?.url) continue
        try {
          const file = await this.downloadImage(image.url, `${finished.job_id}-${index}`)
          imageFiles.push(file)
        } catch {
          // 下载失败时仍把 url 留在卡片文案里
        }
      }
    }

    let pointsLeft: number | undefined
    try {
      const me = await this.client.me(account.accessToken)
      if (typeof me.points === "number") pointsLeft = me.points
      else if (typeof me.quota?.token_remaining === "number") pointsLeft = me.quota.token_remaining
    } catch {
      // ignore
    }

    return { job: finished, template: detail, pointsLeft, imageFiles }
  }

  private async pollJob(token: string, jobId: string): Promise<StudioJob> {
    if (!jobId) throw new StudioApiError(50000, "创建任务后未返回 job_id")
    let last: StudioJob | undefined
    for (let attempt = 0; attempt < 90; attempt++) {
      last = await this.client.getJob(token, jobId)
      const status = String(last.status || "").toLowerCase()
      if (status === "succeeded" || status === "failed" || status === "success" || status === "done") {
        if (status === "success" || status === "done") last.status = "succeeded"
        return last
      }
      await sleep(2000)
    }
    throw new StudioApiError(50000, "生成超时，请稍后在网页端查看任务，或再试一次。")
  }

  private async downloadImage(url: string, stem: string): Promise<string> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`download ${response.status}`)
    const ext = extensionOf(url, response.headers.get("content-type"))
    const file = path.join(this.cacheDir, `${safeName(stem)}${ext}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    fs.writeFileSync(file, buffer)
    return file
  }
}

export function parseMobile(input: string): { mobile: string; areaCode: string } | undefined {
  const digits = input.replace(/\D/g, "")
  if (/^1\d{10}$/.test(digits)) return { mobile: digits, areaCode: "86" }
  if (/^852\d{8}$/.test(digits)) return { mobile: digits.slice(3), areaCode: "852" }
  if (/^86\d{11}$/.test(digits)) return { mobile: digits.slice(2), areaCode: "86" }
  if (/^\d{8}$/.test(digits)) return { mobile: digits, areaCode: "852" }
  return undefined
}

function cardTypeOf(kind: StudioKind): StudioCardType {
  return kind === "copy" ? 1 : 2
}

function kindLabel(kind: StudioKind): string {
  return kind === "copy" ? "文案" : kind === "poster" ? "海报" : "电商套图"
}

function pickTemplate(list: StudioTemplateSummary[], kind: StudioKind): StudioTemplateSummary | undefined {
  if (list.length === 0) return undefined
  const keys =
    kind === "copy"
      ? ["文案", "copy", "推广", "推廣"]
      : kind === "poster"
        ? ["海报", "海報", "poster", "活動", "活动"]
        : ["电商", "電商", "套图", "套圖", "commerce", "背景"]
  const labelOf = (item: StudioTemplateSummary) => `${item.name || ""} ${item.title || ""}`
  const hit = list.find((item) => keys.some((key) => labelOf(item).includes(key)))
  return hit ?? list[0]
}

function isSelectField(field: StudioTemplateField): boolean {
  const type = field.type
  if (type === "select" || type === "radio") return true
  // 线上枚举：3=多选元素、6=风格、7=尺寸
  if (type === 3 || type === 6 || type === 7) return true
  return Array.isArray(field.options) && field.options.length > 0 && type !== "text" && type !== 5
}

function isTextField(field: StudioTemplateField): boolean {
  const type = field.type
  if (typeof type === "string" && /text|textarea|input|string/i.test(type)) return true
  // 5=文本输入
  return type === 5
}

function buildFields(template: StudioTemplateDetail, input: StudioRunInput): Record<string, string> {
  const values = valuesFor(input)
  const fields: Record<string, string> = {}
  const used = new Set<string>()

  for (const field of template.fields) {
    const key = field.name
    const matched = matchValue(key, values)
    if (matched !== undefined) {
      fields[key] = matched
      used.add(key)
      continue
    }
    if (field.default) {
      fields[key] = String(field.default)
      used.add(key)
      continue
    }
    if (isSelectField(field) && field.options?.length) {
      fields[key] = field.options[0]!
      used.add(key)
    }
  }

  // 自由描述覆盖到「產品資訊 / 補充說明」等文案位，避免只留下模板默认示例。
  const leftover = values.prompt || values.scene || values.product
  if (leftover) {
    const prefer =
      template.fields.find((field) => /補充說明|补充说明|產品資訊|产品信息|產品信息|活動主題|活动主题/.test(field.name)) ||
      template.fields.find((field) => field.required && isTextField(field)) ||
      template.fields.find((field) => isTextField(field)) ||
      template.fields.find((field) => field.required) ||
      template.fields[0]
    if (prefer) fields[prefer.name] = leftover
  }

  // 从描述里轻量抽色：用户说「红白」时覆盖色彩字段默认值。
  if (values.prompt && /红|紅|白|黑|青|绿|綠|蓝|藍|黄|黃|金|银|銀/.test(values.prompt)) {
    const colorField = template.fields.find((field) => /色彩|颜色|顏色|配色/.test(field.name))
    if (colorField) {
      const colors: string[] = []
      if (/红|紅/.test(values.prompt)) colors.push("紅色")
      if (/白/.test(values.prompt)) colors.push("白色")
      if (/黑/.test(values.prompt)) colors.push("黑色")
      if (/青/.test(values.prompt)) colors.push("青色")
      if (/绿|綠/.test(values.prompt)) colors.push("綠色")
      if (/蓝|藍/.test(values.prompt)) colors.push("藍色")
      if (/黄|黃/.test(values.prompt)) colors.push("黃色")
      if (/金/.test(values.prompt)) colors.push("金色")
      if (/银|銀/.test(values.prompt)) colors.push("銀色")
      if (colors.length) fields[colorField.name] = colors.join(",")
    }
  }

  for (const field of template.fields) {
    if (field.required && !String(fields[field.name] ?? "").trim()) {
      throw new StudioApiError(40000, `模板字段「${field.name}」为必填，请补充后再生成。`)
    }
  }
  return fields
}

function valuesFor(input: StudioRunInput): Record<string, string> {
  return {
    prompt: input.prompt?.trim() || "",
    product: input.product?.trim() || "",
    channel: input.channel?.trim() || "",
    language: input.language?.trim() || "",
    words: input.words?.trim() || "",
    scene: input.scene?.trim() || "",
    selling: input.selling?.trim() || "",
    platform: input.platform?.trim() || "",
    tone: input.tone?.trim() || "",
  }
}

function matchValue(fieldName: string, values: Record<string, string>): string | undefined {
  const name = fieldName.replace(/\s+/g, "")
  const rules: Array<[RegExp, keyof typeof values]> = [
    [/場景|场景|需求/, "scene"],
    [/產品名稱|产品名称|商品名/, "product"],
    [/賣點|卖点|優惠|优惠|促销/, "selling"],
    [/平台/, "platform"],
    [/語言風格|语言风格|语气|口吻|海報風格|海报风格/, "tone"],
    [/字數|字数/, "words"],
    [/渠道|平台渠道/, "channel"],
    [/語言$|语言$/, "language"],
    [/補充說明|补充说明|產品資訊|产品信息|產品信息|活動主題|活动主题|描述|提示|內容|内容|海报|海報|文案/, "prompt"],
  ]
  for (const [pattern, key] of rules) {
    if (pattern.test(name) && values[key]) return values[key]
  }
  // 电商模板里「产品」常与渠道并列
  if (/產品|产品/.test(name) && values.product) return values.product
  return undefined
}

function extensionOf(url: string, contentType: string | null): string {
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return ".jpg"
  if (contentType?.includes("webp")) return ".webp"
  if (contentType?.includes("gif")) return ".gif"
  if (contentType?.includes("png")) return ".png"
  const pathPart = url.split("?")[0] || ""
  const ext = path.extname(pathPart).toLowerCase()
  if (ext && ext.length <= 5) return ext
  return ".png"
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "image"
}
