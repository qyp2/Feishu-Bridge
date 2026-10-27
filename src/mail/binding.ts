import fs from "node:fs"
import path from "node:path"

export interface MailBinding {
  email: string
  /** Open ID of the user who bound the mailbox (verified against the contact API). */
  boundBy: string
  boundAt: string
}

/**
 * Bridge-owned mailbox binding. ONLY the bridge writes this file — via the bot
 * 「绑定邮箱」 command after verifying the address against the operator's
 * Feishu account through the contact API.
 *
 * This file is the single source of truth for "which mailbox may be read":
 * the loopback mail proxy and the mail watcher both resolve the address from
 * here, so an agent (or anyone chatting with it) cannot redirect mail reads
 * to another person's mailbox by writing files on the agent side.
 */
export class MailBindingStore {
  private readonly file: string

  constructor(storageDir: string) {
    this.file = path.join(storageDir, "mail-binding.json")
  }

  get(): MailBinding | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Record<keyof MailBinding, unknown>>
      if (
        typeof data.email === "string" &&
        data.email.includes("@") &&
        typeof data.boundBy === "string" &&
        data.boundBy.length > 0
      ) {
        return {
          email: data.email,
          boundBy: data.boundBy,
          boundAt: typeof data.boundAt === "string" ? data.boundAt : "",
        }
      }
    } catch {
      /* missing or corrupt: treated as unbound */
    }
    return undefined
  }

  set(binding: MailBinding): void {
    fs.writeFileSync(this.file, JSON.stringify(binding, null, 2), "utf8")
  }
}
