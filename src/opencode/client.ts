import type {
  AgentInfo,
  FormInfo,
  FormValue,
  MessageInfo,
  ModelRef,
  OpencodeEvent,
  PermissionReply,
  PermissionRequest,
  PromptInput,
  SessionInfo,
} from "./types.js"

export interface ClientOptions {
  baseUrl: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  rawBody?: RequestInit["body"]
  contentType?: string | null
  signal?: AbortSignal
}

export class OpencodeError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    readonly payload?: unknown,
  ) {
    super(message)
    this.name = "OpencodeError"
  }
}

/**
 * Thin, dependency-free HTTP client for the OpenCode V2 server.
 *
 * We deliberately use raw fetch instead of the generated client so we can call
 * experimental routes (fs write, session export/import) and control the SSE
 * parsing for streaming text deltas.
 */
export class OpencodeClient {
  readonly baseUrl: string
  readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path)
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    const headers: Record<string, string> = { ...this.headers }
    let body: RequestInit["body"] | undefined
    if (options.rawBody !== undefined) {
      body = options.rawBody
      if (options.contentType) headers["content-type"] = options.contentType
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(options.body)
    }
    const res = await this.fetchImpl(url, { method, headers, body, signal: options.signal })
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let parsed: unknown = undefined
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (!res.ok) {
      const message =
        parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : typeof parsed === "string"
            ? parsed
            : `HTTP ${res.status}`
      throw new OpencodeError(res.status, path, message, parsed)
    }
    return parsed as T
  }

  private async data<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    const result = await this.request<{ data: T }>(method, path, options)
    if (result && typeof result === "object" && "data" in result) return result.data
    return result as unknown as T
  }

  // ---- server / discovery -------------------------------------------------

  async info(): Promise<{ version: string; pid: number; urls: string[]; capabilities?: Record<string, unknown> }> {
    return this.request("GET", "/api/info")
  }

  async reloadConfiguration(): Promise<void> {
    await this.request("POST", "/api/location/reload")
  }

  // ---- agents -------------------------------------------------------------

  async listAgents(directory?: string): Promise<AgentInfo[]> {
    return this.data("GET", "/api/agent", { query: directory ? { "location[directory]": directory } : undefined })
  }

  // ---- sessions -----------------------------------------------------------

  async listSessions(options: { directory?: string; limit?: number } = {}): Promise<SessionInfo[]> {
    const result = await this.request<{ data: SessionInfo[] } | SessionInfo[]>("GET", "/api/session", {
      query: { limit: options.limit, directory: options.directory },
    })
    if (Array.isArray(result)) return result
    const items = (result as { data?: SessionInfo[] }).data ?? []
    return items
  }

  async createSession(input: {
    title?: string
    agent?: string
    model?: ModelRef
    directory?: string
    metadata?: Record<string, unknown>
  }): Promise<SessionInfo> {
    return this.data("POST", "/api/session", {
      body: {
        title: input.title,
        agent: input.agent,
        model: input.model,
        location: input.directory ? { directory: input.directory } : undefined,
        metadata: input.metadata,
      },
    })
  }

  async getSession(sessionID: string): Promise<SessionInfo> {
    return this.data("GET", `/api/session/${sessionID}`)
  }

  async updateSession(sessionID: string, patch: { title?: string; metadata?: Record<string, unknown> }): Promise<void> {
    await this.request("PATCH", `/api/session/${sessionID}`, { body: patch })
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.request("DELETE", `/api/session/${sessionID}`)
  }

  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    await this.request("POST", `/api/session/${sessionID}/model`, { body: { model } })
  }

  async switchAgent(sessionID: string, agent: string): Promise<void> {
    await this.request("POST", `/api/session/${sessionID}/agent`, { body: { agent } })
  }

  async listActiveSessions(): Promise<Record<string, unknown>> {
    return this.data("GET", "/api/session/active")
  }

  // ---- prompting ----------------------------------------------------------

  async prompt(sessionID: string, input: PromptInput): Promise<{ id: string }> {
    return this.data("POST", `/api/session/${sessionID}/prompt`, { body: input })
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.request("POST", `/api/session/${sessionID}/interrupt`)
  }

  async messages(sessionID: string): Promise<MessageInfo[]> {
    const result = await this.request<{ data?: { messages?: MessageInfo[] } | MessageInfo[] }>(
      "GET",
      `/api/session/${sessionID}/message`,
    )
    const data = (result as { data?: unknown }).data
    if (Array.isArray(data)) return data as MessageInfo[]
    const messages = (data as { messages?: MessageInfo[] } | undefined)?.messages
    return messages ?? []
  }

  async sessionLog(sessionID: string): Promise<{ info: SessionInfo; messages: MessageInfo[] } | undefined> {
    return this.data("GET", `/api/experimental/session/${sessionID}/log`)
  }

  // ---- permissions --------------------------------------------------------

  async pendingPermissions(sessionID: string): Promise<PermissionRequest[]> {
    return this.data("GET", `/api/session/${sessionID}/permission`)
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionReply,
    message?: string,
  ): Promise<void> {
    await this.request("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, {
      body: { decision, message },
    })
  }

  // ---- forms (AI questions) ----------------------------------------------

  async pendingForms(sessionID: string): Promise<FormInfo[]> {
    return this.data("GET", `/api/session/${sessionID}/form`)
  }

  async replyForm(sessionID: string, formID: string, answer: Record<string, FormValue>): Promise<void> {
    await this.request("POST", `/api/session/${sessionID}/form/${formID}/reply`, { body: { answer } })
  }

  // ---- filesystem ---------------------------------------------------------

  /** Write raw bytes to an absolute path (or relative to the location). */
  async writeFile(absolutePath: string, data: Uint8Array, directory?: string): Promise<{ path: string }> {
    return this.data("POST", "/api/experimental/fs/write", {
      query: { path: absolutePath, ...(directory ? { "location[directory]": directory } : {}) },
      rawBody: data as unknown as RequestInit["body"],
      contentType: "application/octet-stream",
    })
  }

  // ---- session migration --------------------------------------------------

  async exportSession(sessionID: string, sanitize = true): Promise<{ info: SessionInfo; messages: MessageInfo[] }> {
    return this.data("GET", `/api/experimental/session/${sessionID}/export`, {
      query: { sanitize: String(sanitize) },
    })
  }

  async importSession(payload: {
    info: SessionInfo
    messages: MessageInfo[]
    directory?: string
  }): Promise<SessionInfo> {
    return this.data("POST", "/api/experimental/session/import", {
      body: {
        info: payload.info,
        messages: payload.messages,
        location: payload.directory ? { directory: payload.directory } : undefined,
      },
    })
  }

  // ---- events (SSE) -------------------------------------------------------

  /**
   * Open the live event stream. Yields decoded events until the stream ends or
   * the signal aborts. Callers are expected to reconnect on failure.
   */
  async *streamEvents(signal?: AbortSignal): AsyncGenerator<OpencodeEvent> {
    const url = new URL(this.baseUrl + "/api/event")
    const res = await this.fetchImpl(url, { headers: { ...this.headers, accept: "text/event-stream" }, signal })
    if (!res.ok || !res.body) {
      throw new OpencodeError(res.status, "/api/event", `event stream failed with status ${res.status}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf("\n\n")
        while (index !== -1) {
          const chunk = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = parseSseChunk(chunk)
          if (event) yield event
          index = buffer.indexOf("\n\n")
        }
      }
    } finally {
      reader.releaseLock?.()
      await res.body.cancel().catch(() => {})
    }
  }
}

function parseSseChunk(chunk: string): OpencodeEvent | undefined {
  const dataLines = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
  if (dataLines.length === 0) return undefined
  const payload = dataLines.join("\n")
  if (!payload) return undefined
  try {
    return JSON.parse(payload) as OpencodeEvent
  } catch {
    return undefined
  }
}
