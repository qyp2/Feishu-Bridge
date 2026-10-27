import http from "node:http"
import type { AppConfig } from "../config/index.js"
import type { AuditLog, Logger } from "../util/logger.js"
import type { MailBindingStore } from "./binding.js"

const OPEN_API = "https://open.feishu.cn/open-apis"

/** Query params the agent may pass through to the list endpoint. Everything else is dropped. */
const LIST_QUERY_ALLOW = new Set(["folder_id", "label_id", "only_unread", "page_size", "page_token"])

export interface MailProxyDeps {
  config: AppConfig
  binding: MailBindingStore
  logger: Logger
  audit: AuditLog
}

/**
 * Loopback-only, read-only mail API proxy for agents.
 *
 * Why this exists: the app-level tenant token can read EVERY mailbox listed
 * under the app's 数据权限. Handing that token to the agent (the old mail.mjs
 * read appId/appSecret from the bridge config) meant anyone chatting with the
 * bot could talk the agent into reading someone else's mailbox.
 *
 * Here the agent never sees credentials: it calls this proxy, and the proxy
 * resolves the mailbox exclusively from the bridge-owned binding file (written
 * only by the 「绑定邮箱」 command after contact-API ownership verification).
 * There is no request parameter for choosing a mailbox — the caller simply
 * cannot ask for anyone else's mail.
 *
 * Exposed endpoints (GET only, 127.0.0.1 only):
 *   /mail/list?<folder_id|label_id|only_unread|page_size|page_token>
 *   /mail/messages/<message_id>
 */
export class MailProxy {
  private server?: http.Server
  private tokenCache?: { token: string; expire: number }

  constructor(private readonly deps: MailProxyDeps) {}

  start(): void {
    const port = this.deps.config.mail.proxyPort
    if (!port || this.server) return
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.deps.logger.warn("Mail proxy request failed", { error: error instanceof Error ? error.message : String(error) })
        this.json(res, 500, { code: 50000, msg: "proxy internal error" })
      })
    })
    this.server.on("error", (error) => {
      this.deps.logger.error("Mail proxy server error", { error: error.message })
    })
    this.server.listen(port, "127.0.0.1", () => {
      this.deps.logger.info("Mail proxy listening", { host: "127.0.0.1", port })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = undefined
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method !== "GET") {
      this.json(res, 405, { code: 40500, msg: "method not allowed: the mail proxy is read-only" })
      return
    }
    const messageMatch = /^\/mail\/messages\/([^/]+)$/.exec(url.pathname)
    if (url.pathname !== "/mail/list" && !messageMatch) {
      this.json(res, 404, { code: 40400, msg: "unknown endpoint: use /mail/list or /mail/messages/<id>" })
      return
    }

    const binding = this.deps.binding.get()
    if (!binding) {
      this.json(res, 409, { code: 40901, msg: "mailbox not bound: send 「绑定邮箱」 in chat to bind your own mailbox first" })
      return
    }
    const mailbox = encodeURIComponent(binding.email)

    let pathname: string
    if (messageMatch) {
      // The caller sends an already-encoded id (message ids contain base64 '='
      // padding); decode-then-encode to normalize and avoid double-encoding.
      const messageId = encodeURIComponent(decodeURIComponent(messageMatch[1] ?? ""))
      pathname = `/mail/v1/user_mailboxes/${mailbox}/messages/${messageId}`
    } else {
      const params = new URLSearchParams()
      for (const [key, value] of url.searchParams) {
        if (LIST_QUERY_ALLOW.has(key)) params.set(key, value)
      }
      const size = Number(params.get("page_size") ?? "10")
      params.set("page_size", String(Math.min(Math.max(size || 10, 1), 50)))
      pathname = `/mail/v1/user_mailboxes/${mailbox}/messages?${params}`
    }

    this.deps.audit.record("mail.proxy", { endpoint: messageMatch ? "get" : "list", mailbox: binding.email })
    const data = await this.api(pathname)
    // Pass the Feishu response through verbatim (code/msg/data) so the agent
    // side keeps its existing error handling (e.g. 99991672/99991679 hints).
    this.json(res, 200, data)
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(body))
  }

  private async token(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expire > Date.now() + 5 * 60_000) return this.tokenCache.token
    const botConfig = this.deps.config.bots.find((bot) => bot.name === this.deps.config.mail.bot) ?? this.deps.config.bots[0]
    if (!botConfig) throw new Error("no bot configured for mail proxy credentials")
    const resp = await fetch(`${OPEN_API}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: botConfig.appId, app_secret: botConfig.appSecret }),
    })
    const data = (await resp.json()) as { code: number; msg: string; tenant_access_token?: string; expire?: number }
    if (data.code !== 0 || !data.tenant_access_token) throw new Error(`token rejected: ${data.msg}`)
    this.tokenCache = { token: data.tenant_access_token, expire: Date.now() + (data.expire ?? 7200) * 1000 }
    return this.tokenCache.token
  }

  private async api(pathname: string): Promise<Record<string, unknown>> {
    const resp = await fetch(`${OPEN_API}${pathname}`, { headers: { Authorization: `Bearer ${await this.token()}` } })
    const rawText = await resp.text()
    try {
      return JSON.parse(rawText) as Record<string, unknown>
    } catch {
      return { code: resp.status || 50001, msg: `non-JSON upstream response: ${rawText.slice(0, 200)}` }
    }
  }
}
