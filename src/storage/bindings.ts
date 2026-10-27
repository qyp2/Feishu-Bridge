import path from "node:path"
import { readJson, writeJson } from "../util/jsonfile.js"
import { ensureDir, safeSegment } from "../util/paths.js"
import type { ModelRef, PromptFileAttachment } from "../opencode/types.js"

export interface Binding {
  /** Stable key: `${bot}:${chatId}` or `${bot}:${chatId}:${userId}`. */
  key: string
  bot: string
  chatId: string
  chatType: "p2p" | "group"
  userId?: string
  sessionID: string
  directory: string
  agent: string
  model?: ModelRef
  title?: string
  /**
   * Files received without accompanying text, held until the user says what to
   * do with them. They are attached to the next text prompt.
   */
  pendingAttachments?: PromptFileAttachment[]
  /**
   * ID of the last assistant message whose text was already delivered to the
   * chat. Used by the recovery sweep to push a final answer that was produced
   * after its turn had already ended (turn timeout or bridge restart) without
   * ever delivering it twice.
   */
  lastDeliveredMessageID?: string
  /** Absolute paths already uploaded for this chat, so a later sweep does not send them again. */
  sentFilePaths?: string[]
  /**
   * Feishu card of the turn that is still streaming. Kept so a bridge restart
   * can finish that same card instead of leaving a spinner behind.
   */
  progressMessageID?: string
  progressCardID?: string
  createdAt: number
  updatedAt: number
}

interface BindingsFile {
  version: number
  bindings: Record<string, Binding>
}

/**
 * Durable map of chat conversations to OpenCode sessions. Persisted as a single
 * JSON document with atomic writes; the whole thing is small enough to keep in
 * memory.
 */
export class BindingStore {
  private readonly file: string
  private readonly bindings = new Map<string, Binding>()
  private readonly bySession = new Map<string, string>()
  private dirty = false
  private flushTimer?: NodeJS.Timeout

  constructor(storageDir: string) {
    ensureDir(storageDir)
    this.file = path.join(storageDir, "bindings.json")
    const data = readJson<BindingsFile>(this.file, { version: 1, bindings: {} })
    for (const binding of Object.values(data.bindings ?? {})) {
      this.bindings.set(binding.key, binding)
      this.bySession.set(binding.sessionID, binding.key)
    }
  }

  static key(bot: string, chatId: string, userId?: string): string {
    return userId ? `${bot}:${chatId}:${userId}` : `${bot}:${chatId}`
  }

  static directory(root: string, bot: string, chatId: string, userId?: string): string {
    const segment = safeSegment(userId ? `${chatId}_${userId}` : chatId)
    return path.join(root, safeSegment(bot), segment)
  }

  get(key: string): Binding | undefined {
    return this.bindings.get(key)
  }

  getBySession(sessionID: string): Binding | undefined {
    const key = this.bySession.get(sessionID)
    return key ? this.bindings.get(key) : undefined
  }

  set(binding: Binding): void {
    this.bindings.set(binding.key, binding)
    this.bySession.set(binding.sessionID, binding.key)
    this.markDirty()
  }

  delete(key: string): void {
    const existing = this.bindings.get(key)
    if (existing) this.bySession.delete(existing.sessionID)
    this.bindings.delete(key)
    this.markDirty()
  }

  deleteBySession(sessionID: string): void {
    const key = this.bySession.get(sessionID)
    if (key) this.delete(key)
  }

  all(): Binding[] {
    return [...this.bindings.values()]
  }

  private markDirty(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, 250)
    this.flushTimer.unref?.()
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    const data: BindingsFile = { version: 1, bindings: Object.fromEntries(this.bindings) }
    writeJson(this.file, data)
  }
}
