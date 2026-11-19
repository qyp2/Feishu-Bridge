import { escapeMarkdown, nextFormNonce, type CardValue } from "../feishu/cards.js"
import type { IntelItem } from "./archive.js"

export type IntelAction = "cost" | "compete" | "plan" | "track" | "exclude"

const TOAST: Record<IntelAction, string> = {
  cost: "🤖 正在估算研发人天、硬件/API 成本与排期...",
  compete: "🤖 正在调阅竞品历史轨迹并生成差距对比...",
  plan: "🤖 正在调阅读取历史偏好并生成方案...",
  track: "⭐ 正在把该机构加入深度追踪...",
  exclude: "已记录偏好。下期将自动过滤此类/此源资讯。",
}

export function intelToast(action: string | undefined): { content: string; type: "info" | "success" } {
  if (action === "exclude" || action === "track") {
    return { content: TOAST[action], type: "success" }
  }
  if (action === "cost" || action === "compete" || action === "plan") return { content: TOAST[action], type: "info" }
  return { content: "正在处理这条情报...", type: "info" }
}

/** Zero-increment notice. Prefer plain text over an empty card. */
export const INTEL_QUIET_NOTICE = "本期未检索到新动态，已为您节省时间"

export function intelEmptyCard(topic: string): object {
  return card(
    "ℹ️ 情报档案",
    "grey",
    [
      {
        tag: "markdown",
        content: `**【情报档案：${escapeMarkdown(topic)}】** ${INTEL_QUIET_NOTICE}`,
      },
    ],
  )
}

export function intelDigestCard(
  topic: string,
  items: IntelItem[],
  nextLabel: string,
  lockedIds: Iterable<string> = [],
): object {
  const nonce = nextFormNonce()
  const locked = new Set(lockedIds)
  const elements: object[] = [
    {
      tag: "markdown",
      content: `本期增量 **${items.length}** 条 · 下期 ${escapeMarkdown(nextLabel)}`,
    },
  ]
  items.forEach((item, index) => {
    if (index > 0) elements.push({ tag: "hr" })
    elements.push({ tag: "markdown", content: itemBody(index + 1, item, topic) })
    elements.push(
      item.status === "excluded"
        ? excludedRow()
        : actionRow(topic, item, nonce, locked.has(item.id)),
    )
  })
  const built = card(digestTitle(topic, items.length, nextLabel), "blue", elements)
  assertNoExternalUrlInVisibleText(built)
  return built
}

export function intelActionCard(action: Exclude<IntelAction, "exclude" | "track">, itemTitle: string, body: string): object {
  const title =
    action === "cost"
      ? `💰 成本与排期 — ${clip(itemTitle, 24)}`
      : action === "compete"
        ? `⚔️ 竞品差距 — ${clip(itemTitle, 24)}`
        : "🎯 竞标策略"
  return card(title, action === "plan" ? "turquoise" : "blue", [
    { tag: "markdown", content: body.trim() },
  ])
}

function itemBody(index: number, item: IntelItem, topic: string): string {
  const summary = stripUrls(item.summary.replace(/\s+/g, " ").trim() || "待核实")
  const title = stripUrls(item.title)
  const tag = domainTag(topic)
  const lines = [`**${index}. ${escapeMarkdown(title)}**（${escapeMarkdown(item.date)}）`, `领域：${escapeMarkdown(tag)}`]
  if (item.matchedTrackedEntity) {
    lines.push(`【⭐ 特别关注】${escapeMarkdown(stripUrls(item.matchedTrackedEntity))}`)
  }
  lines.push(`摘要：${escapeMarkdown(summary)}`)
  return lines.join("\n")
}

function actionRow(jobName: string, item: IntelItem, nonce: number, trackedLocked: boolean): object {
  const button = (text: string, action: IntelAction, disabled = false): object => {
    if (disabled) {
      return {
        tag: "button",
        text: { tag: "plain_text", content: text },
        type: "default",
        disabled: true,
      }
    }
    return {
      tag: "button",
      text: { tag: "plain_text", content: text },
      type: "default",
      behaviors: [
        {
          type: "callback",
          value: {
            n: nonce,
            k: "intel",
            d: action,
            f: item.id,
            s: jobName,
            u: item.url,
            e: item.subjectEntity || item.matchedTrackedEntity || "",
          } satisfies CardValue,
        },
      ],
    }
  }
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: [
      button("🎯 竞标/拿方案", "plan"),
      button(trackedLocked ? "⭐ 已深度追踪" : "⭐ 追踪该机构", "track", trackedLocked),
      button("💰 估成本", "cost"),
      button("⚔️ 查竞品", "compete"),
    ].map((element) => ({ tag: "column", width: "auto", elements: [element] })),
  }
}

function excludedRow(): object {
  return {
    tag: "column_set",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "已排除 ✕" },
            type: "default",
            disabled: true,
          },
        ],
      },
    ],
  }
}

function digestTitle(topic: string, count: number, nextLabel: string): string {
  const suffix = `（${count}条 · 下期 ${nextLabel}）`
  const room = Math.max(6, 72 - suffix.length)
  const name = topic.length > room ? `${topic.slice(0, room)}…` : topic
  return `📰 ${name}${suffix}`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function domainTag(topic: string): string {
  if (/网安|安全|cyber|vulnerab/i.test(topic)) return "网安"
  if (/办公|office|协作/i.test(topic)) return "办公"
  if (/教育|edu|学校|校园/i.test(topic)) return "教育"
  if (/娱乐|流媒体|内容平台/i.test(topic)) return "娱乐"
  if (/算力|智算|计算|computing/i.test(topic)) return "算力"
  if (/手机|移动业务|mobile/i.test(topic)) return "手机业务"
  return "资讯"
}

function stripUrls(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function assertNoExternalUrlInVisibleText(cardObj: object): void {
  const visible = collectVisibleText(cardObj).join("\n")
  if (/https?:\/\//i.test(visible) || /\bwww\./i.test(visible)) {
    throw new Error("主推送卡片正文不能出现外部链接")
  }
}

function collectVisibleText(node: unknown): string[] {
  if (!node || typeof node !== "object") return []
  if (Array.isArray(node)) return node.flatMap(collectVisibleText)
  const row = node as Record<string, unknown>
  const parts: string[] = []
  if (typeof row.content === "string" && row.tag === "markdown") parts.push(row.content)
  if (row.text && typeof row.text === "object") {
    const text = (row.text as { content?: unknown }).content
    if (typeof text === "string") parts.push(text)
  }
  if (row.header && typeof row.header === "object") parts.push(...collectVisibleText(row.header))
  if (row.body && typeof row.body === "object") parts.push(...collectVisibleText(row.body))
  if (Array.isArray(row.elements)) parts.push(...collectVisibleText(row.elements))
  if (Array.isArray(row.columns)) parts.push(...collectVisibleText(row.columns))
  return parts
}

function card(title: string, template: string, elements: object[]): object {
  return {
    schema: "2.0",
    config: { update_multi: true, streaming_mode: false },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  }
}
