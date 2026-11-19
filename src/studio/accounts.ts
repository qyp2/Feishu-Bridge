import path from "node:path"
import { readJson, writeJson } from "../util/jsonfile.js"

export interface StudioAccount {
  openId: string
  mobile: string
  areaCode: string
  accessToken: string
  updatedAt: number
}

type AccountFile = Record<string, StudioAccount>

/** 按飞书 openId 持久化玉树登录态，文件位于 bridge data 目录。 */
export class StudioAccountStore {
  private readonly file: string

  constructor(storageDir: string) {
    this.file = path.join(storageDir, "studio-accounts.json")
  }

  get(openId: string): StudioAccount | undefined {
    const id = openId.trim()
    if (!id) return undefined
    return this.load()[id]
  }

  set(account: StudioAccount): void {
    const all = this.load()
    all[account.openId] = account
    writeJson(this.file, all)
  }

  clear(openId: string): void {
    const all = this.load()
    if (!all[openId]) return
    delete all[openId]
    writeJson(this.file, all)
  }

  private load(): AccountFile {
    return readJson<AccountFile>(this.file, {})
  }
}
