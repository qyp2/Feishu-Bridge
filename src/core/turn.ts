interface ToolState {
  name: string
  status: string
  detail?: string
  /** When the tool reached a terminal status (completed/error). */
  settledAt?: number
}

/**
 * True when the text is only the live-card chrome (处理完成 / 解读指令) or
 * empty. That shell is not an answer and must never be cached or delivered.
 */
export function isProgressShell(text: string): boolean {
  const stripped = text
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/[✅❌⏰｜|]/g, "")
    .replace(/处理完成|解读指令中?|已理解你的指令|正在理解你的指令|整理回复中?|收到，正在生成/g, "")
    .replace(/\s+/g, "")
  return stripped.length === 0
}

export interface TranscriptMessage {
  id: string
  text: string
  tools: { id: string; name: string; status: string }[]
}

/**
 * Accumulates the streaming events of a single assistant turn into the
 * Markdown that is progressively rendered in the Feishu card.
 */
export class TurnAccumulator {
  private readonly segments = new Map<string, string>()
  private readonly order: string[] = []
  private readonly tools = new Map<string, ToolState>()
  private reasoning = ""
  private fileNames: string[] = []
  /** When the latest text delta/snapshot arrived. */
  private lastTextAt = 0
  /** Prepended to the card headline (e.g. "⏰ 资讯订阅 · 晨报" for cron turns). */
  titlePrefix = ""

  constructor(
    private readonly showTools: boolean,
    private readonly showReasoning: boolean,
  ) {}

  private key(messageID: string, ordinal: number): string {
    return `${messageID}:${ordinal}`
  }

  addText(messageID: string, ordinal: number, delta: string): void {
    const key = this.key(messageID, ordinal)
    if (!this.segments.has(key)) this.order.push(key)
    this.segments.set(key, (this.segments.get(key) ?? "") + delta)
    this.lastTextAt = Date.now()
  }

  setText(messageID: string, ordinal: number, text: string): void {
    const key = this.key(messageID, ordinal)
    if (!this.segments.has(key)) this.order.push(key)
    this.segments.set(key, text)
    this.lastTextAt = Date.now()
  }

  addReasoning(delta: string): void {
    this.reasoning += delta
  }

  /** File names from this turn, shown on the first progress layer. */
  setFileNames(names: string[]): void {
    this.fileNames = names.map((name) => name.trim()).filter((name) => name.length > 0)
  }

  setTool(id: string, name: string, status: string, detail?: string): void {
    const previous = this.tools.get(id)
    const settledAt =
      status === "completed" || status === "error"
        ? (previous?.settledAt ?? Date.now())
        : undefined
    this.tools.set(id, { name, status, detail: detail ?? previous?.detail, settledAt })
  }

  toolDetail(id: string, detail: string): void {
    const existing = this.tools.get(id)
    if (existing) existing.detail = detail
  }

  /**
   * Catch tool and text updates the live stream missed. A long sub-agent call
   * can finish on the server while the card is still showing it as running.
   * Server text replaces the local copy only when it is at least as long, so a
   * lagging snapshot does not wipe text that already streamed.
   */
  absorb(messages: TranscriptMessage[]): boolean {
    let changed = false
    for (const message of messages) {
      if (message.text) {
        const prefix = `${message.id}:`
        const keys = this.order.filter((key) => key.startsWith(prefix))
        const current = keys.map((key) => this.segments.get(key) ?? "").join("\n\n").trim()
        if (message.text !== current && message.text.length >= current.length) {
          for (const key of keys) this.segments.delete(key)
          for (let index = this.order.length - 1; index >= 0; index -= 1) {
            if (this.order[index]?.startsWith(prefix)) this.order.splice(index, 1)
          }
          this.setText(message.id, 0, message.text)
          changed = true
        }
      }
      for (const tool of message.tools) {
        const existing = this.tools.get(tool.id)
        if (existing && (existing.status === "completed" || existing.status === "error") && tool.status === "running") {
          continue
        }
        if (!tool.name.startsWith("调用")) continue
        const name = tool.name
        if (!existing || existing.status !== tool.status || existing.name !== name) {
          this.setTool(tool.id, name, tool.status)
          changed = true
        }
      }
    }
    return changed
  }

  get text(): string {
    return this.order.map((key) => this.segments.get(key) ?? "").join("\n\n").trim()
  }

  /** The latest assistant message only, so progress notes are not shown to the user. */
  get lastText(): string {
    const key = this.order[this.order.length - 1]
    if (!key) return ""
    return (this.segments.get(key) ?? "").trim()
  }

  get hasContent(): boolean {
    return this.text.length > 0
  }

  get hasRunning(): boolean {
    return visibleTools(this.tools).some((tool) => tool.status !== "completed" && tool.status !== "error")
  }

  /**
   * When the latest reply announces a step that never actually started, ask
   * for that step. When a sub-agent already returned but the visible reply is
   * only a placeholder promise, ask for the real conclusion. A finished reply
   * that neither misses a step nor is a bare promise is left alone so the
   * turn can close.
   */
  continuationPrompt(): string | undefined {
    const tools = visibleTools(this.tools)
    const next = nextStage(this.lastText, tools)
    if (next) return `请立刻调用 ${next.agent}，完成「${next.title}」。不要只写说明。`
    const settled = tools.filter((tool) => tool.status === "completed" || tool.status === "error")
    if (settled.length === 0) return undefined
    // A sub-agent returned after the last visible text, so whatever the reply
    // says it cannot contain the result. Or the reply came later but is only
    // a placeholder promise. Both need the real conclusion.
    const unfinished = settled.some((tool) => (tool.settledAt ?? 0) >= this.lastTextAt)
    if (unfinished || isTransitionText(this.lastText)) {
      return "子 Agent 已经返回结果。请立刻把结果整理成完整结论发给用户；不要只说正在处理或稍后发送。"
    }
    return undefined
  }

  /**
   * Live cards show only the layers reached so far. A finished turn keeps those
   * layers and appends the last reply.
   */
  render(phase: "live" | "done" = "done"): string {
    const parts: string[] = []
    const tools = this.showTools ? visibleTools(this.tools) : []
    const busy = tools.some((tool) => tool.status !== "completed" && tool.status !== "error")
    const waiting = phase === "live" && Boolean(nextStage(this.lastText, tools))
    if (this.showTools) parts.push(renderLayers(buildLayers(tools, this.fileNames, phase, this.lastText), this.titlePrefix))
    if (!busy && !waiting) {
      const answer = this.lastText
      if (answer) parts.push(answer)
    }
    if (this.showReasoning && this.reasoning.trim()) {
      const quoted = this.reasoning
        .trim()
        .split("\n")
        .map((line) => `> ${truncate(line, 400)}`)
        .join("\n")
      parts.push(`**思考**\n${quoted}`)
    }
    return parts.join("\n\n")
  }

  /**
   * Headline for a delivered card, derived the same way as the live card's
   * first line, so fallback / recovered deliveries match what the user saw
   * while the turn was running.
   */
  headline(): string {
    const base = !this.showTools
      ? "✅ 处理完成"
      : layerHeadline(buildLayers(visibleTools(this.tools), this.fileNames, "done", this.lastText))
    return this.titlePrefix ? `${this.titlePrefix}｜${base}` : base
  }
}

interface ProgressLayer {
  title: string
  detail: string
  status: "running" | "completed" | "error"
}

const LAYER_COPY: Record<string, { agent: string; title: string; running: string; done: string; hints: RegExp }> = {
  "调用 A11 需求": { agent: "pm-a11-requirements", title: "梳理需求", running: "正在整理需求范围和验收标准", done: "需求已经整理完", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a11|梳理需求/i },
  "调用 A12 竞品": { agent: "pm-a12-competitor", title: "梳理竞品", running: "正在对照竞品和差异点", done: "竞品已经整理完", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a12|梳理竞品/i },
  "调用 A13 市场": { agent: "pm-a13-market", title: "梳理市场", running: "正在整理市场规模、竞争和机会", done: "市场判断已经完成", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a13|梳理市场/i },
  "调用 A21 研发": { agent: "pm-a21-rd", title: "梳理研发", running: "正在整理研发路径", done: "研发判断已经完成", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a21|梳理研发/i },
  "调用 A22 测试": { agent: "pm-a22-qa", title: "梳理测试", running: "正在整理测试范围", done: "测试判断已经完成", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a22|梳理测试/i },
  "调用 A23 发布": { agent: "pm-a23-release", title: "梳理发布", running: "正在整理发布安排", done: "发布判断已经完成", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a23|梳理发布/i },
  "调用 A31 运营": { agent: "pm-a31-ops", title: "梳理运营", running: "正在整理运营动作", done: "运营判断已经完成", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a31|梳理运营/i },
  "调用 A32 反馈": { agent: "pm-a32-feedback", title: "梳理反馈", running: "正在整理反馈和问题", done: "反馈已经整理完", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a32|梳理反馈/i },
  "调用 A41 线索": { agent: "pm-a41-leads", title: "梳理线索", running: "正在整理线索来源", done: "线索已经整理完", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a41|梳理线索/i },
  "调用 A42 跟进": { agent: "pm-a42-followup", title: "梳理跟进", running: "正在整理跟进动作", done: "跟进已经整理完", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a42|梳理跟进/i },
  "调用 A43 正文": { agent: "pm-a43-conversion", title: "撰写正文", running: "正在按材料和前序结论组织正文", done: "正文已经写好", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a43|撰写正文/i },
  "调用 A44 业绩": { agent: "pm-a44-performance", title: "梳理业绩", running: "正在整理业绩数据", done: "业绩已经整理完", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a44|梳理业绩/i },
  "调用 A51 支持": { agent: "pm-a51-support", title: "梳理支持", running: "正在整理支持方案", done: "支持方案已经整理完", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a51|梳理支持/i },
  "调用 A52 知识": { agent: "pm-a52-knowledge", title: "梳理知识", running: "正在整理可复用的知识点", done: "知识已经整理完", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a52|梳理知识/i },
  "调用 A53 伙伴": { agent: "pm-a53-partner", title: "梳理伙伴", running: "正在整理合作伙伴", done: "伙伴判断已经完成", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a53|梳理伙伴/i },
  "调用 A54 风险": { agent: "pm-a54-risk", title: "梳理风险", running: "正在整理风险和应对", done: "风险判断已经完成", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a54|梳理风险/i },
  "调用 A81 商机": { agent: "pm-a81-opportunity", title: "商机雷达", running: "正在多角度搜索展会与资讯", done: "商机推荐已经生成", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a81|商机|展会|活动推荐|行业资讯/i },
  "调用 A61 成稿": { agent: "pm-a61-deliverable", title: "套模板成稿", running: "正在套用模板并生成文件", done: "文件已经生成", hints: /(?:调用|开始|进入|发起)\s*(?:pm-)?a61|(?:调用|开始|进入|发起)[^。\n]{0,12}成稿|套模板成稿/i },
}

/**
 * A placeholder promise is short, mentions ongoing work ("正在检索…整理好就
 * 发给你"), and carries no substance (no table, list, or structured lines).
 */
function isTransitionText(text: string): boolean {
  const t = text.trim()
  if (t.length === 0 || t.length > 200) return false
  if (!/(正在|稍后|稍等|马上|整理好|发给你|发送|处理中|检索中|尽快|已提交|会回到|回到|后续|之后发|发出|呈上|回报)/.test(t)) return false
  return !/[|#*•·]/.test(t) && !/\n\s*[-\d]/.test(t)
}

function nextStage(text: string, tools: ToolState[]): { agent: string; title: string; running: string } | undefined {
  if (!text) return undefined
  if (tools.some((tool) => tool.status !== "completed" && tool.status !== "error")) return undefined
  let bestAt = Number.POSITIVE_INFINITY
  let chosen: { agent: string; title: string; running: string } | undefined
  for (const [name, copy] of Object.entries(LAYER_COPY)) {
    const match = copy.hints.exec(text)
    if (!match) continue
    if (tools.some((tool) => tool.name === name)) continue
    if (match.index >= bestAt) continue
    bestAt = match.index
    chosen = { agent: copy.agent, title: copy.title, running: copy.running }
  }
  return chosen
}

function buildLayers(tools: ToolState[], fileNames: string[], phase: "live" | "done", text: string): ProgressLayer[] {
  const interpreted = tools.length > 0 || phase === "done" || text.length > 0
  const withFiles = fileNames.length > 0
  const layers: ProgressLayer[] = [
    {
      title: interpreted ? "解读指令" : "解读指令中",
      detail: interpreted
        ? withFiles
          ? `已理解指令，已读到 ${fileNames.join("、")}`
          : "已理解你的指令"
        : withFiles
          ? "正在理解你的指令，并读取本次上传的文件"
          : "正在理解你的指令",
      status: interpreted ? "completed" : "running",
    },
  ]
  for (const tool of tools) {
    const copy = LAYER_COPY[tool.name]
    const title = copy?.title ?? tool.name.replace(/^调用\s*/, "")
    if (tool.status === "error") {
      layers.push({ title, detail: `${title}没有完成`, status: "error" })
      continue
    }
    if (tool.status === "completed") {
      layers.push({ title, detail: copy?.done ?? "这一步已经完成", status: "completed" })
      continue
    }
    layers.push({ title: `${title}中`, detail: copy?.running ?? "正在处理这一步", status: "running" })
  }
  const busy = tools.some((tool) => tool.status !== "completed" && tool.status !== "error")
  const next = phase === "live" && !busy ? nextStage(text, tools) : undefined
  if (next) {
    layers.push({ title: `${next.title}中`, detail: next.running, status: "running" })
  } else if (phase === "live" && tools.length > 0 && !busy) {
    layers.push({ title: "整理回复中", detail: "正在把这一轮的结果写成回复", status: "running" })
  }
  return layers
}

/**
 * Card headline derived from the task layers, so the card is titled by what
 * the turn is actually doing (e.g. "梳理竞品") instead of a fixed string.
 * Process layers (解读指令/整理回复) never become the headline.
 */
function layerHeadline(layers: ProgressLayer[]): string {
  const task = [...layers].reverse().find((layer) => !/^(解读指令|整理回复)/.test(layer.title))
  const failed = layers.some((layer) => layer.status === "error")
  const running = layers.some((layer) => layer.status === "running")
  if (task) {
    const name = task.title.replace(/中$/, "")
    if (failed) return `❌ ${name}未完成`
    if (running) return `🤖 ${name}…`
    return `✅ ${name}完成`
  }
  if (failed) return "❌ 任务未完成"
  if (running) return "🤖 正在处理"
  return "✅ 处理完成"
}

function renderLayers(layers: ProgressLayer[], titlePrefix = ""): string {
  const bars = barFrame()
  const headline = layerHeadline(layers)
  const lines = [`**${titlePrefix ? `${titlePrefix}｜` : ""}${headline}**`, ""]
  for (const layer of layers) {
    if (layer.status === "completed") lines.push(`<font color='green'>✅</font> **${layer.title}**`)
    else if (layer.status === "error") lines.push(`<font color='red'>❌</font> **${layer.title}**`)
    else lines.push(`<font color='green'>${bars}</font> **${layer.title}**`)
    lines.push(`<font color='grey'>｜ ${layer.detail}</font>`)
    lines.push("")
  }
  return lines.join("\n").trim()
}

/** One line per sub-agent. A finished call wins over an older spinning one. */
function visibleTools(tools: Map<string, ToolState>): ToolState[] {
  const chosen = new Map<string, ToolState>()
  const order: string[] = []
  for (const tool of tools.values()) {
    if (!tool.name.startsWith("调用")) continue
    const previous = chosen.get(tool.name)
    if (!previous) {
      chosen.set(tool.name, tool)
      order.push(tool.name)
      continue
    }
    if (statusRank(tool.status) >= statusRank(previous.status)) chosen.set(tool.name, tool)
  }
  return order.map((name) => chosen.get(name)).filter((tool): tool is ToolState => Boolean(tool))
}

function statusRank(status: string): number {
  if (status === "error") return 3
  if (status === "completed") return 2
  return 1
}

const SPINNER = ["◐", "◓", "◑", "◒"]
const BARS = ["▍", "▍▍", "▍▍▍"]

/** Frame of the in-progress mark. Advances about once per card refresh. */
export function spinnerFrame(now = Date.now()): string {
  return SPINNER[Math.floor(now / 700) % SPINNER.length] ?? "◐"
}

/** Three rising bars for the layer that is still working. */
function barFrame(now = Date.now()): string {
  return BARS[Math.floor(now / 700) % BARS.length] ?? "▍"
}

/** Keep one card element under Feishu's size limit so updates are not split into new cards. */
export function fitCardMarkdown(text: string, limit = 12000): string {
  if (text.length <= limit) return text
  const tail = text.slice(text.length - limit)
  const cut = tail.indexOf("\n")
  const body = cut >= 0 && cut < 200 ? tail.slice(cut + 1) : tail
  return `较早的过程已折叠，下面是最近的内容。\n\n${body}`
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim()
  return single.length > max ? single.slice(0, max) + "…" : single
}
