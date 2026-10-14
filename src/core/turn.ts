interface ToolState {
  name: string
  status: string
  detail?: string
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
  }

  setText(messageID: string, ordinal: number, text: string): void {
    const key = this.key(messageID, ordinal)
    if (!this.segments.has(key)) this.order.push(key)
    this.segments.set(key, text)
  }

  addReasoning(delta: string): void {
    this.reasoning += delta
  }

  setTool(id: string, name: string, status: string, detail?: string): void {
    this.tools.set(id, { name, status, detail: detail ?? this.tools.get(id)?.detail })
  }

  toolDetail(id: string, detail: string): void {
    const existing = this.tools.get(id)
    if (existing) existing.detail = detail
  }

  get text(): string {
    return this.order.map((key) => this.segments.get(key) ?? "").join("\n\n").trim()
  }

  get hasContent(): boolean {
    return this.text.length > 0
  }

  render(): string {
    const parts: string[] = []
    const text = this.text
    if (text) parts.push(text)
    if (this.showTools && this.tools.size > 0) {
      const lines = [...this.tools.values()].map((tool) => {
        const icon = tool.status === "completed" ? "✅" : tool.status === "error" ? "❌" : "🔧"
        const detail = tool.detail ? ` \`${truncate(tool.detail, 80)}\`` : ""
        return `${icon} ${tool.name}${detail}`
      })
      parts.push(`---\n${lines.join("\n")}`)
    }
    if (this.showReasoning && this.reasoning.trim()) {
      const quoted = this.reasoning
        .trim()
        .split("\n")
        .map((line) => `> ${truncate(line, 400)}`)
        .join("\n")
      parts.push(`---\n**思考**\n${quoted}`)
    }
    return parts.join("\n\n")
  }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim()
  return single.length > max ? single.slice(0, max) + "…" : single
}
