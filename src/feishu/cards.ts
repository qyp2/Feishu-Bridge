import type { FormField, FormInfo, PermissionRequest } from "../opencode/types.js"

/** A stable marker used to route card callbacks back to the bridge. */
export interface CardValue {
  k: "perm" | "form" | "menu" | "cancel"
  s?: string
  r?: string
  d?: string
  f?: string
  key?: string
  v?: unknown
  /** Per-render nonce so re-rendered cards are not collapsed by the SDK's click dedup. */
  n?: number
}

export interface CardAction {
  tag: string
  text: { tag: "plain_text"; content: string }
  type?: string
  value: CardValue
}

function callbackButton(text: string, value: CardValue, type = "default"): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    behaviors: [{ type: "callback", value }],
  }
}

/**
 * A button that lives inside a card `form` container and submits every input
 * value alongside its own callback payload (`action.form_value`).
 *
 * `name` is mandatory for interactive components inside a form container —
 * without it Feishu drops the whole submission.
 */
function formSubmitButton(text: string, value: CardValue, type: string, name: string): object {
  return {
    tag: "button",
    name,
    text: { tag: "plain_text", content: text },
    type,
    form_action_type: "submit",
    behaviors: [{ type: "callback", value }],
  }
}

function buttonRow(buttons: object[]): object {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: buttons.map((b) => ({ tag: "column", width: "auto", elements: [b] })),
  }
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1")
}

function baseCard(title: string, template: string, elements: object[]): object {
  return {
    schema: "2.0",
    config: { update_multi: true, streaming_mode: false },
    header: {
      title: { tag: "plain_text", content: title },
      template,
    },
    body: { elements },
  }
}

export function markdownCard(title: string, markdown: string, template = "blue"): object {
  return baseCard(title, template, [{ tag: "markdown", content: markdown }])
}

export function statusCard(title: string, markdown: string, template = "turquoise"): object {
  return baseCard(title, template, [{ tag: "markdown", content: markdown }])
}

export function permissionCard(request: PermissionRequest): object {
  const lines = [
    `**操作：** \`${escapeMarkdown(request.action)}\``,
    request.resources?.length ? `**资源：**\n${request.resources.map((r) => `- \`${escapeMarkdown(r)}\``).join("\n")}` : "",
    request.message ? `\n${escapeMarkdown(request.message)}` : "",
  ].filter(Boolean)
  return baseCard("🔐 需要授权", "orange", [
    { tag: "markdown", content: lines.join("\n") },
    buttonRow([
      callbackButton("仅本次允许", { k: "perm", s: request.sessionID, r: request.id, d: "once" }, "primary"),
      callbackButton("始终允许", { k: "perm", s: request.sessionID, r: request.id, d: "always" }, "default"),
      callbackButton("拒绝", { k: "perm", s: request.sessionID, r: request.id, d: "reject" }, "danger"),
    ]),
  ])
}

function fieldHeader(field: FormField, index: number): string {
  const title = field.title ?? field.key
  const required = field.required ? " *必填*" : ""
  const description = field.description ? `\n${escapeMarkdown(field.description)}` : ""
  return `**${index + 1}. ${escapeMarkdown(title)}${required}**${description}`
}

function optionsOf(field: FormField): { value: string; label: string }[] {
  const options = Array.isArray(field.options) ? field.options : []
  return options
    .filter((o): o is { value: string; label?: string } => typeof (o as { value?: unknown }).value === "string")
    .map((o) => ({ value: o.value, label: o.label ?? o.value }))
}

/**
 * Render an OpenCode form (the AI asking a question) as an interactive card.
 *
 * OpenCode's question tool marks every field as `custom: true`: the options are
 * only suggestions, and the user is expected to be able to type their own
 * answer. So each field gets both preset option buttons *and* a free-form text
 * input. Everything lives inside a single card `form` container, which means a
 * click on any option (or the submit button) submits the whole form together
 * with whatever the user typed into the inputs (`action.form_value`).
 */
export function formCard(form: FormInfo, answers: Record<string, unknown>): object {
  // A fresh nonce per render keeps each button's callback payload unique, so a
  // re-rendered card is not swallowed by the SDK's 12h click dedup while a
  // genuine Feishu re-delivery of the same render still is.
  const nonce = nextFormNonce()
  const elements: object[] = []
  if (form.metadata && typeof form.metadata === "object" && "description" in form.metadata) {
    elements.push({
      tag: "markdown",
      content: escapeMarkdown(String((form.metadata as { description: unknown }).description)),
    })
  }
  form.fields.forEach((field, index) => {
    if (field.hidden) return
    elements.push(...formFieldElements(field, index, form, answers, nonce))
  })
  elements.push({ tag: "hr" })
  elements.push({
    tag: "markdown",
    content: `<font color='grey'>表单 ${form.id} · 完成后将自动提交给 AI · 也可回复 \`/answer ${form.id} ${form.fields[0]?.key ?? "key"}=你的回答\`</font>`,
    text_size: "notation",
  })
  elements.push(
    buttonRow([
      formSubmitButton("✅ 提交", { n: nonce, k: "form", s: form.sessionID, f: form.id }, "primary", "submit"),
    ]),
  )
  return baseCard("❓ AI 提问", "wathet", [
    { tag: "form", name: `opencode_${form.id}`.slice(0, 40), elements },
  ])
}

/** The label + preset buttons + free-form input for a single form field. */
function formFieldElements(
  field: FormField,
  index: number,
  form: FormInfo,
  answers: Record<string, unknown>,
  nonce: number,
): object[] {
  const elements: object[] = []
  const answered = Object.prototype.hasOwnProperty.call(answers, field.key)
  const current = answers[field.key]
  const options = optionsOf(field)
  const multi = field.type === "multiselect" && options.length > 0
  const summary = answered ? `\n已选择：**${escapeMarkdown(formatAnswer(current))}**` : ""
  elements.push({ tag: "markdown", content: `${fieldHeader(field, index)}${summary}` })

  if (field.type === "boolean") {
    elements.push(
      buttonRow([
        formSubmitButton(
          "是",
          { n: nonce, k: "form", s: form.sessionID, f: form.id, key: field.key, v: true },
          current === true ? "primary" : "default",
          `${field.key}_yes`,
        ),
        formSubmitButton(
          "否",
          { n: nonce, k: "form", s: form.sessionID, f: form.id, key: field.key, v: false },
          current === false ? "primary" : "default",
          `${field.key}_no`,
        ),
      ]),
    )
    return elements
  }

  if (options.length > 0) {
    const selected = multi ? (Array.isArray(current) ? current.map(String) : []) : []
    elements.push(
      buttonRow(
        options.map((option, optionIndex) => {
          const isSelected = multi ? selected.includes(option.value) : String(current ?? "") === option.value
          return formSubmitButton(
            isSelected ? `✅ ${option.label}` : option.label,
            { n: nonce, k: "form", s: form.sessionID, f: form.id, key: field.key, v: option.value },
            isSelected ? "primary" : "default",
            `${field.key}_opt_${optionIndex}`,
          )
        }),
      ),
    )
  }

  if (!multi) {
    elements.push({
      tag: "input",
      name: field.key,
      width: "fill",
      placeholder: {
        tag: "plain_text",
        content: options.length > 0 ? "也可直接输入你的回答" : "请输入你的回答",
      },
      default_value: answerText(current).slice(0, 500),
    })
  }
  return elements
}

let formRenderSeq = 0

function nextFormNonce(): number {
  formRenderSeq = (formRenderSeq + 1) % Number.MAX_SAFE_INTEGER
  return formRenderSeq
}

function answerText(value: unknown): string {
  if (value == null) return ""
  if (Array.isArray(value)) return value.map(String).join(", ")
  return String(value)
}

function formatAnswer(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join("、")
  return value == null ? "" : String(value)
}

export function helpCard(): object {
  const commands = [
    "/new — 开启一个全新会话",
    "/reset — 重置并新建会话",
    "/sessions — 列出当前会话",
    "/agent <name> — 切换 Agent",
    "/model <provider/model> — 切换模型",
    "/stop — 中断当前执行",
    "/export — 导出当前会话（迁移用）",
    "/import <json> — 导入会话（迁移用）",
    "/answer <formId> key=value — 回答 AI 提问",
    "/cron list | add … — 管理定时任务",
    "/whoami — 显示当前绑定信息",
    "/help — 显示本帮助",
  ]
  return baseCard("🤖 OpenCode 机器人", "blue", [
    { tag: "markdown", content: "我可以把你的消息转发给 OpenCode，并实时流式回复。\n\n**支持：**\n- 文本、图片、文件（图片/文本会作为上下文附件）\n- 交互式卡片授权与提问\n- 每个会话独立目录，上下文互不干扰\n- 定时任务、会话迁移" },
    { tag: "hr" },
    { tag: "markdown", content: commands.map((c) => `- \`${c}\``).join("\n") },
  ])
}
