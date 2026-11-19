import { createHash } from "node:crypto"
import path from "node:path"
import { readJson, writeJson } from "../util/jsonfile.js"

/** One pushed or rejected intelligence item. The url is the dedup key. */
export interface IntelItem {
  id: string
  url: string
  title: string
  summary: string
  date: string
  status: "pushed" | "excluded"
  pushedAt: number
  excludedAt?: number
  /** Hit from trackedEntities when this item was accepted. */
  matchedTrackedEntity?: string
  /** Entity name used by the track button. */
  subjectEntity?: string
}

interface IntelDelivery {
  nextLabel: string
  itemIds: string[]
  /** Item ids whose track button was already pressed on this card. */
  lockedIds?: string[]
  at: number
}

interface IntelArchive {
  jobName: string
  topic: string
  items: IntelItem[]
  trackedEntities: string[]
  lastRun?: { at: number; count: number }
  /** Cards already sent, so a later click can refresh that exact message. */
  deliveries: Record<string, IntelDelivery>
}

export interface ParsedIntelItem {
  title: string
  url: string
  summary: string
  date: string
  entity?: string
}

export type IntelReport =
  | { kind: "legacy" }
  | { kind: "empty" }
  | { kind: "items"; items: ParsedIntelItem[] }

const MAX_ITEMS = 200
const MAX_EXCLUDED = 80
const MAX_DELIVERIES = 20
const PROMPT_ROWS = 30
const HISTORY_MS = 30 * 24 * 60 * 60 * 1000

/**
 * What the scheduled search must print. The bridge parses this and never
 * shows the markers. A plain answer (no markers) stays on the old card.
 */
const OUTPUT_RULES = [
  "【定时资讯订阅 · Bridge 执行说明】",
  "- 本任务由商机资讯子代理 A81（pm-a81-opportunity）执行。",
  "- 必须加载技能: s82-intel-digest（S82 资讯订阅消化）。不要改用 S81 推荐卡片模板。",
  "- 只用 OpenCode 的 websearch / webfetch，不要调用 Tavily、Serper 或其他外挂搜索 API。",
  "- 仍按上面的主题检索；去重后按下面格式交卷。不要写开场白，不要生成文件，不要写 [[send-file: ...]]。",
  "没有新条目时只输出一行：@@EMPTY",
  "有新条目时每条一块，最多 5 条，每条必须有可打开的链接，没有链接的不要写：",
  "@@ITEM",
  "标题: ",
  "日期: YYYY-MM-DD（原文没有就写待核实）",
  "链接: https://...",
  "摘要: 不超过80字",
  "实体: 命中的关注实体；未命中可留空",
  "@@END",
].join("\n")

export class IntelArchiveStore {
  private readonly file: string

  constructor(storageDir: string) {
    this.file = path.join(storageDir, "intel-archives.json")
  }

  /** Extra instructions appended to a non-mail subscription prompt. */
  promptBlock(name: string): string {
    const archive = this.ensure(name)
    const pushed = archive.items.filter((item) => item.status === "pushed").slice(-PROMPT_ROWS)
    const excluded = archive.items.filter((item) => item.status === "excluded").slice(-PROMPT_ROWS)
    const tracked = archive.trackedEntities
    const focus = tracked.length
      ? `高亮/关注实体（必须优先放进 websearch Query）：${tracked.join("、")}`
      : "高亮/关注实体：无"
    const lines = [
      OUTPUT_RULES,
      focus,
      "已经推过的条目不要再报，也不要换个标题复述：",
      pushed.length ? pushed.map(lineOf).join("\n") : "（尚无）",
      "用户标记过不感兴趣的来源和题目，下次搜索当作排除项，不要再出现：",
      excluded.length ? excluded.map(lineOf).join("\n") : "（尚无）",
    ]
    return lines.join("\n")
  }

  trackedEntities(name: string): string[] {
    return [...this.ensure(name).trackedEntities]
  }

  addTrackedEntities(name: string, entities: string[]): string[] {
    const all = this.load()
    const archive = all[name] ?? emptyArchive(name)
    const next = [...archive.trackedEntities]
    for (const raw of entities) {
      const text = raw.trim()
      if (text.length < 2 || next.includes(text)) continue
      next.push(text)
    }
    archive.trackedEntities = next
    all[name] = archive
    this.save(all)
    return next
  }

  /** Items the card may show. Nothing is written until `commit`. */
  preview(name: string, incoming: ParsedIntelItem[]): IntelItem[] {
    const archive = this.ensure(name)
    const fresh: IntelItem[] = []
    const now = Date.now()
    for (const item of incoming) {
      const url = normalizeUrl(item.url)
      if (!url) continue
      const id = itemId(url)
      if (archive.items.some((row) => row.id === id || normalizeUrl(row.url) === url)) continue
      if (fresh.some((row) => row.id === id)) continue
      const matched = matchTracked(
        `${item.title}\n${item.summary}\n${item.entity ?? ""}`,
        archive.trackedEntities,
      )
      const subject = (item.entity?.trim() || matched || "").trim()
      fresh.push({
        id,
        url,
        title: clip(item.title, 120),
        summary: clip(item.summary, 400),
        date: item.date || "待核实",
        status: "pushed",
        pushedAt: now,
        matchedTrackedEntity: matched,
        subjectEntity: subject || undefined,
      })
    }
    return fresh
  }

  /** Remember a digest that was actually sent. */
  commit(name: string, items: IntelItem[]): void {
    if (items.length === 0) return
    const all = this.load()
    const archive = all[name] ?? emptyArchive(name)
    for (const item of items) {
      if (archive.items.some((row) => row.id === item.id)) continue
      archive.items.push(item)
    }
    archive.items = trimItems(archive.items)
    all[name] = archive
    this.save(all)
  }

  markRun(name: string, count: number): void {
    const all = this.load()
    const archive = all[name] ?? emptyArchive(name)
    archive.lastRun = { at: Date.now(), count }
    all[name] = archive
    this.save(all)
  }

  rememberDelivery(name: string, messageId: string, itemIds: string[], nextLabel: string): void {
    if (!messageId) return
    const all = this.load()
    const archive = all[name]
    if (!archive) return
    archive.deliveries[messageId] = { nextLabel, itemIds, lockedIds: [], at: Date.now() }
    const entries = Object.entries(archive.deliveries).sort((a, b) => a[1].at - b[1].at)
    while (entries.length > MAX_DELIVERIES) {
      const oldest = entries.shift()
      if (oldest) delete archive.deliveries[oldest[0]]
    }
    this.save(all)
  }

  lockDeliveryItem(name: string, messageId: string, itemId: string): void {
    const all = this.load()
    const archive = all[name]
    const saved = archive?.deliveries[messageId]
    if (!archive || !saved) return
    const locked = saved.lockedIds ?? []
    if (!locked.includes(itemId)) locked.push(itemId)
    saved.lockedIds = locked
    this.save(all)
  }

  exclude(name: string, itemId: string): boolean {
    const all = this.load()
    const archive = all[name]
    const row = archive?.items.find((item) => item.id === itemId)
    if (!row || row.status === "excluded") return false
    row.status = "excluded"
    row.excludedAt = Date.now()
    this.save(all)
    return true
  }

  getItem(name: string, itemId: string): IntelItem | undefined {
    return this.load()[name]?.items.find((item) => item.id === itemId)
  }

  /** 订阅改名后旧卡片仍带旧名字：用条目 id 找回现行档案名。 */
  findArchiveForItem(itemId: string): string | undefined {
    const id = itemId.trim()
    if (!id) return undefined
    for (const [name, archive] of Object.entries(this.load())) {
      if (archive.items.some((item) => item.id === id)) return name
    }
    return undefined
  }

  /** Pushed items from the last 30 days, oldest first, for the competitor card. */
  recent(name: string): IntelItem[] {
    const cutoff = Date.now() - HISTORY_MS
    return (this.load()[name]?.items ?? [])
      .filter((item) => item.status === "pushed" && item.pushedAt >= cutoff)
      .slice(-PROMPT_ROWS)
  }

  /** Rebuild one already-sent digest, including rows the user has since excluded. */
  delivery(
    name: string,
    messageId: string,
  ): { topic: string; nextLabel: string; items: IntelItem[]; lockedIds: string[] } | undefined {
    const archive = this.load()[name]
    const saved = archive?.deliveries[messageId]
    if (!archive || !saved) return undefined
    const items = saved.itemIds
      .map((id) => archive.items.find((item) => item.id === id))
      .filter((item): item is IntelItem => Boolean(item))
    if (items.length === 0) return undefined
    return {
      topic: archive.topic,
      nextLabel: saved.nextLabel,
      items,
      lockedIds: [...(saved.lockedIds ?? [])],
    }
  }

  rename(from: string, to: string): void {
    if (!from || !to || from === to) return
    const all = this.load()
    const current = all[from]
    if (!current) return
    const target = all[to]
    if (!target) {
      all[to] = { ...current, jobName: to, topic: to }
      delete all[from]
      this.save(all)
      return
    }
    // 目标档案已存在（预生成抢先建了空档）：合并条目与关注实体，再删旧名。
    const seen = new Set(target.items.map((item) => item.id))
    for (const item of current.items) {
      if (seen.has(item.id)) continue
      target.items.push(item)
      seen.add(item.id)
    }
    for (const entity of current.trackedEntities ?? []) {
      if (entity && !target.trackedEntities.includes(entity)) target.trackedEntities.push(entity)
    }
    for (const [messageId, delivery] of Object.entries(current.deliveries ?? {})) {
      if (!target.deliveries[messageId]) target.deliveries[messageId] = delivery
    }
    target.jobName = to
    target.topic = to
    all[to] = target
    delete all[from]
    this.save(all)
  }

  drop(name: string): void {
    const all = this.load()
    if (!all[name]) return
    delete all[name]
    this.save(all)
  }

  private ensure(name: string): IntelArchive {
    const all = this.load()
    const archive = all[name] ?? emptyArchive(name)
    if (!Array.isArray(archive.trackedEntities)) archive.trackedEntities = []
    if (!all[name]) {
      all[name] = archive
      this.save(all)
    }
    return archive
  }

  private load(): Record<string, IntelArchive> {
    const raw = readJson<Record<string, IntelArchive>>(this.file, {})
    for (const archive of Object.values(raw)) {
      if (!Array.isArray(archive.trackedEntities)) archive.trackedEntities = []
    }
    return raw
  }

  private save(all: Record<string, IntelArchive>): void {
    writeJson(this.file, all)
  }
}

export function parseIntelReport(text: string): IntelReport {
  const source = text.replace(/\r\n/g, "\n")
  const blocks = [...source.matchAll(/@@ITEM\s*([\s\S]*?)@@END/gi)]
  if (blocks.length === 0) {
    return /@@EMPTY\b/i.test(source) ? { kind: "empty" } : { kind: "legacy" }
  }
  const items: ParsedIntelItem[] = []
  for (const block of blocks) {
    const body = block[1] ?? ""
    const title = field(body, ["标题", "title"])
    const url = field(body, ["链接", "url", "link"])
    const summary = field(body, ["摘要", "summary"])
    const date = field(body, ["日期", "date"]) || "待核实"
    const entity = field(body, ["实体", "entity"])
    if (title.length < 2 || !/^https?:\/\//i.test(url)) continue
    items.push({ title, url: url.trim(), summary: summary || "待核实", date, entity: entity || undefined })
    if (items.length >= 5) break
  }
  return items.length > 0 ? { kind: "items", items } : { kind: "empty" }
}

export function matchTracked(text: string, entities: string[]): string | undefined {
  const folded = text.toLowerCase()
  for (const name of entities) {
    const token = name.trim()
    if (token.length < 2) continue
    if (folded.includes(token.toLowerCase())) return token
  }
  return undefined
}

function emptyArchive(name: string): IntelArchive {
  return { jobName: name, topic: name, items: [], trackedEntities: [], deliveries: {} }
}

function lineOf(item: IntelItem): string {
  return `- ${item.title} | ${item.url}`
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

function field(block: string, names: string[]): string {
  for (const name of names) {
    const match = block.match(new RegExp(`^${name}\\s*[:：]\\s*(.+)$`, "im"))
    if (match?.[1]) return match[1].trim()
  }
  return ""
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  try {
    const parsed = new URL(trimmed)
    parsed.hash = ""
    const pathName = parsed.pathname.replace(/\/$/, "")
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathName}${parsed.search}`
  } catch {
    return trimmed
  }
}

function itemId(url: string): string {
  return createHash("sha1").update(normalizeUrl(url)).digest("hex").slice(0, 12)
}

function trimItems(items: IntelItem[]): IntelItem[] {
  const excluded = items.filter((item) => item.status === "excluded")
  const pushed = items.filter((item) => item.status === "pushed")
  const keptExcluded = excluded.slice(-MAX_EXCLUDED)
  const room = Math.max(0, MAX_ITEMS - keptExcluded.length)
  return [...pushed.slice(-room), ...keptExcluded]
}
