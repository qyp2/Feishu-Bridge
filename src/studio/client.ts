/**
 * 玉树色彩 Open API v1 客户端。仅供创作工作台 / 登录使用，不介入其它桥接逻辑。
 * Base: {YUSHU_OPEN_API_BASE||https://yushucolor.com}/llm/open/v1
 */

export type StudioCardType = 1 | 2

export interface StudioMe {
  user_id?: number | string
  mobile?: string
  area_code?: string
  points?: number
  status?: string
  quota?: {
    token_quota?: number
    token_used?: number
    token_remaining?: number
    role_id?: number
  }
}

export interface StudioTemplateSummary {
  id: number
  name: string
  title?: string
  card_type: number
  cover?: string
  image?: string
  description?: string
}

export interface StudioTemplateField {
  name: string
  /** 文档示例为 string；线上接口为数字枚举（如 5=文本、3/6/7=选项类）。 */
  type: string | number
  required?: boolean
  options?: string[]
  default?: string
}

export interface StudioTemplateDetail extends StudioTemplateSummary {
  fields: StudioTemplateField[]
}

export interface StudioJob {
  job_id: string
  template_id?: number
  request_id?: string
  status: "pending" | "running" | "succeeded" | "failed" | string
  dry_run?: boolean
  text?: string
  images?: Array<{ url: string; width?: number; height?: number }>
  created_at?: string
  updated_at?: string
  message?: string
}

export class StudioApiError extends Error {
  constructor(
    readonly code: number | string,
    message: string,
  ) {
    super(message)
    this.name = "StudioApiError"
  }
}

export class StudioClient {
  readonly baseUrl: string

  constructor(baseUrl?: string) {
    const root = (baseUrl || process.env.YUSHU_OPEN_API_BASE || "https://yushucolor.com").replace(/\/$/, "")
    this.baseUrl = `${root}/llm/open/v1`
  }

  async sendSms(mobile: string, areaCode = "852"): Promise<void> {
    await this.request("POST", "/auth/sms", { body: { mobile, area_code: areaCode } })
  }

  async login(mobile: string, code: string, areaCode = "852"): Promise<{ access_token: string; token_type?: string }> {
    const data = await this.request<Record<string, unknown>>("POST", "/auth/login", {
      body: { mobile, code, area_code: areaCode },
    })
    const token = String(data.access_token ?? data.token ?? "")
    if (!token) throw new StudioApiError(50000, "登录成功但未返回 access_token")
    return { access_token: token, token_type: data.token_type ? String(data.token_type) : "Bearer" }
  }

  async me(token: string): Promise<StudioMe> {
    const data = await this.request<StudioMe>("GET", "/me", { token })
    return normalizeMe(data)
  }

  async listTemplates(token: string, cardType?: StudioCardType): Promise<StudioTemplateSummary[]> {
    const query = cardType ? `?card_type=${cardType}` : ""
    const data = await this.request<unknown>("GET", `/templates${query}`, { token })
    return unwrapList<Record<string, unknown>>(data).map(normalizeTemplateSummary)
  }

  async getTemplate(token: string, id: number): Promise<StudioTemplateDetail> {
    const data = await this.request<Record<string, unknown>>("GET", `/templates/${id}`, { token })
    const detail = normalizeTemplateDetail(data)
    if (!detail.id) throw new StudioApiError(40400, `模板 ${id} 不存在`)
    return detail
  }

  async createJob(
    token: string,
    body: { template_id: number; fields: Record<string, string>; request_id?: string },
  ): Promise<StudioJob> {
    const data = await this.request<unknown>("POST", "/jobs", { token, body })
    return normalizeJob(data)
  }

  async getJob(token: string, jobId: string): Promise<StudioJob> {
    const data = await this.request<unknown>("GET", `/jobs/${encodeURIComponent(jobId)}`, { token })
    return normalizeJob(data)
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options?: { token?: string; body?: unknown },
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (options?.body !== undefined) headers["Content-Type"] = "application/json"
    if (options?.token) {
      headers.Authorization = `Bearer ${options.token}`
      headers.token = options.token
    }
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      })
    } catch (error) {
      throw new StudioApiError(50000, `无法连接创作接口：${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      throw new StudioApiError(response.status, text.slice(0, 200) || `HTTP ${response.status}`)
    }
    if (json && typeof json === "object" && "code" in json) {
      const row = json as { code: number | string; message?: string; msg?: string; data?: T }
      const code = row.code
      if (code !== 0 && code !== "0") {
        throw new StudioApiError(code, row.message || row.msg || `请求失败(${code})`)
      }
      return (row.data ?? ({} as T)) as T
    }
    if (!response.ok) {
      throw new StudioApiError(response.status, text.slice(0, 200) || `HTTP ${response.status}`)
    }
    return json as T
  }
}

function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === "object") {
    const row = data as { list?: T[]; items?: T[]; templates?: T[] }
    if (Array.isArray(row.list)) return row.list
    if (Array.isArray(row.items)) return row.items
    if (Array.isArray(row.templates)) return row.templates
  }
  return []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function normalizeMe(data: StudioMe | Record<string, unknown>): StudioMe {
  const row = (data || {}) as StudioMe
  const quota = row.quota
  const remaining = quota?.token_remaining
  if (typeof row.points !== "number" && typeof remaining === "number") {
    row.points = remaining
  }
  return row
}

function normalizeTemplateSummary(raw: Record<string, unknown>): StudioTemplateSummary {
  const title = String(raw.title ?? raw.name ?? "")
  const image = raw.image != null ? String(raw.image) : undefined
  const cover = raw.cover != null ? String(raw.cover) : image
  return {
    id: Number(raw.id),
    name: title,
    title,
    card_type: Number(raw.card_type ?? 0),
    cover,
    image,
    description: raw.description != null ? String(raw.description) : undefined,
  }
}

function normalizeTemplateDetail(raw: Record<string, unknown> | undefined): StudioTemplateDetail {
  const base = normalizeTemplateSummary(raw || {})
  const fieldsRaw = Array.isArray(raw?.fields) ? raw!.fields : []
  const fields: StudioTemplateField[] = fieldsRaw
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((field) => ({
      name: String(field.name ?? ""),
      type: (field.type ?? "text") as string | number,
      required: Boolean(field.required),
      options: Array.isArray(field.options) ? field.options.map(String) : [],
      default: field.default != null ? String(field.default) : undefined,
    }))
    .filter((field) => field.name)
  return { ...base, fields }
}

/** 线上返回 `data.job.id` + `images: string[]`；文档草案为扁平 `job_id` + `{url}[]`。 */
export function normalizeJob(raw: unknown): StudioJob {
  const root = asRecord(raw) || {}
  const nested = asRecord(root.job)
  const row = nested || root
  const jobId = String(row.job_id ?? row.id ?? row.jobId ?? "")
  const images = normalizeImages(row.images)
  return {
    job_id: jobId,
    template_id: row.template_id != null ? Number(row.template_id) : undefined,
    request_id: row.request_id != null ? String(row.request_id) : undefined,
    status: String(row.status || "pending"),
    dry_run: Boolean(row.dry_run),
    text: row.text != null ? String(row.text) : undefined,
    images,
    created_at: row.created_at != null ? String(row.created_at) : undefined,
    updated_at: row.updated_at != null ? String(row.updated_at) : undefined,
    message: row.message != null ? String(row.message) : undefined,
  }
}

function normalizeImages(raw: unknown): Array<{ url: string; width?: number; height?: number }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ url: string; width?: number; height?: number }> = []
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({ url: item.trim() })
      continue
    }
    const row = asRecord(item)
    if (!row) continue
    const url = String(row.url ?? row.src ?? row.image ?? "").trim()
    if (!url) continue
    out.push({
      url,
      width: typeof row.width === "number" ? row.width : undefined,
      height: typeof row.height === "number" ? row.height : undefined,
    })
  }
  return out
}
