import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { ensureDir } from "../util/paths.js"

export interface MailBinding {
  email: string
  boundAt: string
  /** Presented by this user's session directory. The proxy maps it to the mailbox; the agent cannot choose an address. */
  scope: string
  /** Where important-mail pushes go. Empty until this user has an active mail subscription. */
  chatId?: string
  bot?: string
}

interface StoreFile {
  users?: Record<string, Partial<MailBinding>>
  /** Legacy single-slot binding. Migrated into `users` on load. */
  email?: string
  boundBy?: string
  boundAt?: string
}

/**
 * One mailbox per Feishu user. ONLY the bridge writes this file, after the
 * subscribe card (or 「绑定邮箱」) checks the address against that user's
 * contact record. The mail proxy resolves a mailbox from the scope token in
 * the caller's session directory, so a subscription cannot fall through to
 * someone else's inbox.
 */
export class MailBindingStore {
  private readonly file: string
  private readonly users = new Map<string, MailBinding>()

  constructor(storageDir: string) {
    ensureDir(storageDir)
    this.file = path.join(storageDir, "mail-binding.json")
    this.load()
  }

  get(openId: string): MailBinding | undefined {
    return this.users.get(openId)
  }

  all(): Array<{ openId: string; binding: MailBinding }> {
    return [...this.users.entries()].map(([openId, binding]) => ({ openId, binding }))
  }

  findByScope(scope: string): { openId: string; binding: MailBinding } | undefined {
    const token = scope.trim()
    if (!token) return undefined
    for (const [openId, binding] of this.users) {
      if (binding.scope === token) return { openId, binding }
    }
    return undefined
  }

  /** True when this address is already bound to a different user. */
  takenByOther(email: string, openId: string): boolean {
    const needle = email.trim().toLowerCase()
    for (const [id, binding] of this.users) {
      if (id !== openId && binding.email.toLowerCase() === needle) return true
    }
    return false
  }

  set(openId: string, email: string, delivery?: { chatId: string; bot: string }): MailBinding {
    const prev = this.users.get(openId)
    const same = prev !== undefined && prev.email.toLowerCase() === email.trim().toLowerCase()
    const next: MailBinding = {
      email: email.trim(),
      boundAt: same ? prev.boundAt : new Date().toISOString(),
      scope: same ? prev.scope : newScope(),
      chatId: delivery?.chatId ?? prev?.chatId,
      bot: delivery?.bot ?? prev?.bot,
    }
    this.users.set(openId, next)
    this.persist()
    return next
  }

  touchDelivery(openId: string, chatId: string, bot: string): void {
    const prev = this.users.get(openId)
    if (!prev) return
    prev.chatId = chatId
    prev.bot = bot
    this.persist()
  }

  clearDelivery(openId: string): void {
    const prev = this.users.get(openId)
    if (!prev?.chatId) return
    delete prev.chatId
    this.persist()
  }

  private load(): void {
    let data: StoreFile
    try {
      data = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoreFile
    } catch {
      return
    }
    let dirty = false
    if (data.users && typeof data.users === "object") {
      for (const [openId, raw] of Object.entries(data.users)) {
        const binding = normalize(raw)
        if (!binding || !openId) continue
        if (!raw.scope) dirty = true
        this.users.set(openId, binding)
      }
    } else if (typeof data.email === "string" && data.email.includes("@") && typeof data.boundBy === "string" && data.boundBy) {
      this.users.set(data.boundBy, {
        email: data.email.trim(),
        boundAt: typeof data.boundAt === "string" ? data.boundAt : "",
        scope: newScope(),
      })
      dirty = true
    }
    if (dirty) this.persist()
  }

  private persist(): void {
    const users: Record<string, MailBinding> = {}
    for (const [openId, binding] of this.users) users[openId] = binding
    fs.writeFileSync(this.file, JSON.stringify({ users }, null, 2), "utf8")
  }
}

export function writeMailScope(directory: string, scope: string): void {
  ensureDir(directory)
  fs.writeFileSync(path.join(directory, "mail.scope"), scope.trim(), "utf8")
}

function newScope(): string {
  return crypto.randomBytes(24).toString("hex")
}

function normalize(raw: Partial<MailBinding> | undefined): MailBinding | undefined {
  if (!raw || typeof raw.email !== "string" || !raw.email.includes("@")) return undefined
  return {
    email: raw.email.trim(),
    boundAt: typeof raw.boundAt === "string" ? raw.boundAt : "",
    scope: typeof raw.scope === "string" && raw.scope.trim() ? raw.scope.trim() : newScope(),
    chatId: typeof raw.chatId === "string" && raw.chatId ? raw.chatId : undefined,
    bot: typeof raw.bot === "string" && raw.bot ? raw.bot : undefined,
  }
}
