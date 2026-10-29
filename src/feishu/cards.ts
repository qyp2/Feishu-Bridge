import type { FormField, FormInfo, PermissionRequest } from "../opencode/types.js"
import type { CronJobInfo } from "../core/commands.js"
import { describeSkill, type Skill, type SkillScope } from "../skills/store.js"

/** A stable marker used to route card callbacks back to the bridge. */
export interface CardValue {
  k: "perm" | "form" | "menu" | "cancel" | "gap" | "cron-sub" | "cron-mail-sub" | "cron-cancel" | "cron-del" | "cron-del-yes" | "cron-pause" | "cron-edit" | "cron-mgr" | "cron-urgent" | "make-form" | "make-sub" | "make-refresh" | "make-addfile" | "make-cancel" | "studio" | "login" | "skill-mgr" | "skill-new" | "skill-edit" | "skill-del" | "skill-del-yes" | "skill-save" | "skill-cancel" | "skill-use"
  s?: string
  r?: string
  d?: string
  f?: string
  key?: string
  v?: unknown
  /** Per-render nonce so re-rendered cards are not collapsed by the SDK's click dedup. */
  n?: number
  /** Group card owner. Callbacks from anyone else are ignored. */
  o?: string
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

/**
 * 时间戳基数 + 毫秒内自增：纯内存计数在 tsx watch 重载后会归零，可能撞上
 * 12h 去重窗口内旧卡片的 value（点击被 SDK 吞掉，表现为「回调失败」）。
 */
export function nextFormNonce(): number {
  formRenderSeq = (formRenderSeq + 1) % 1000
  return Date.now() * 1000 + formRenderSeq
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

export interface GapFillField {
  key: string
  heading: string
}

/**
 * System card for missing deliverable sections. Every field is a text input.
 * There are no preset choices: the user types the missing body and submits.
 */
export function gapFillCard(token: string, fields: GapFillField[], multiline: boolean, omitted = 0): object {
  const nonce = nextFormNonce()
  const elements: object[] = [
    {
      tag: "markdown",
      content:
        "以下内容在上传的材料里没有。请直接输入对应正文。留空的项保持「未提供」。提交后继续生成文件。" +
        (omitted > 0 ? `\n\n还有 ${omitted} 项未列出，这些项保持「未提供」。` : ""),
    },
  ]
  fields.forEach((field, index) => {
    elements.push({
      tag: "markdown",
      content: `**${index + 1}. ${escapeMarkdown(field.heading)}**`,
    })
    const input: Record<string, unknown> = {
      tag: "input",
      name: field.key,
      width: "fill",
      max_length: 1000,
      placeholder: { tag: "plain_text", content: "请输入这一节的正文" },
    }
    if (multiline) {
      input.input_type = "multiline_text"
      input.rows = 4
    }
    elements.push(input)
  })
  elements.push({ tag: "hr" })
  elements.push(
    buttonRow([
      formSubmitButton("提交并继续", { n: nonce, k: "gap", f: token }, "primary", "submit"),
    ]),
  )
  return baseCard("补充缺失内容", "orange", [
    { tag: "form", name: `gap_${token}`.slice(0, 40), elements },
  ])
}

export function gapDoneCard(markdown: string, template = "green"): object {
  return statusCard("补充缺失内容", markdown, template)
}

export function gapRetryCard(reason: string, token: string): object {
  return baseCard("补充缺失内容", "red", [
    { tag: "markdown", content: `补充已保存，但文件还没有发出。\n\n${escapeMarkdown(reason)}` },
    buttonRow([callbackButton("重试生成", { k: "gap", f: token }, "primary")]),
  ])
}

/** Greeting reply: what this bot can do, shown when a message has no task words. */
export function welcomeCard(sharedTemplates: string[], personalTemplates: string[] = []): object {
  const parts: string[] = []
  if (sharedTemplates.length) parts.push(`共享模板：${sharedTemplates.map((name) => `「${name}」`).join("、")}`)
  if (personalTemplates.length) parts.push(`我的模板：${personalTemplates.map((name) => `「${name}」`).join("、")}`)
  const templateLine = parts.length
    ? `${parts.join("；")}。说「用${personalTemplates[0] ?? sharedTemplates[0]}模板」即可套用；也支持随消息上传新模板。`
    : "支持随消息上传企业模板套用；发 .pptx 并写「存为模板 名字」可建立个人模板库。"
  return baseCard("🤖 产品智能助手", "blue", [
    {
      tag: "markdown",
      content:
        "你好！我专注于产品团队的**文档成稿与产品分析**，目前重点支持这些任务：",
    },
    {
      tag: "markdown",
      content: [
        "- 📊 **商业计划书 PPT 生成**：给材料即可自动成稿，套用企业模板直接汇报",
        "- 📄 **产品标准化请示文档生成**：九大模块结构化请示，支持 PPT / Word / PDF",
        "- 📉 **产品市场退出报告生成**：退出背景、影响与安排全套材料",
        "- 📡 **商机资讯雷达**：推荐产品/领域相关展会、活动与资讯，支持追问分析与个人定时订阅",
        "- 📈 **产品管理专题分析**：需求、竞品、市场、研发、测试、发布、运营、反馈等 20 类",
        "- 📑 **办公文件一键导出**：Markdown 内容转 PPT / Word / Excel / PDF",
      ].join("\n"),
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `**模板库**\n${templateLine}\n\n**我的技能**\n把你的做法攒成技能：说「技能」打开管理卡片，点「新建技能」填触发词与步骤，以后提到触发词就自动照做。\n\n**小提示**：直接说出任务即可，例如「用移动内部汇报模板做一份 XX 产品商业计划书 PPT」；点击下方菜单「帮助」查看使用说明。`,
    },
  ])
}

function selectOption(label: string, value: string): object {
  return { text: { tag: "plain_text", content: label }, value }
}

/** 多选下拉（form 容器内使用）;initial 为预选 value 数组。 */
function multiSelectStatic(name: string, placeholder: string, options: object[], initial?: string[]): object {
  const el: Record<string, unknown> = {
    tag: "multi_select_static",
    name,
    width: "fill",
    placeholder: { tag: "plain_text", content: placeholder },
    options,
  }
  if (initial && initial.length > 0) el.initial_value = initial
  return el
}

// ---- 制作中心 --------------------------------------------------------------

export type MakeFormat = "pptx" | "docx" | "pdf" | "xlsx" | "copy"

export interface MakeFormData {
  format: MakeFormat
  /** 已发到本会话的本地文件（缓存）:label 展示名,value 缓存文件名。 */
  files: Array<{ label: string; value: string }>
  sharedTemplates: string[]
  personalTemplates: string[]
}

/** 刷新重渲染时的回填值:用户已填内容一字不丢。 */
export interface MakeFormPreset {
  instruction?: string
  template?: string
  cloud?: string
  /** 预选的缓存文件名(value 数组):已勾选 + 新拖入的本地文件。 */
  files?: string[]
}

const MAKE_COPY: Record<MakeFormat, { title: string; formatWord: string }> = {
  pptx: { title: "PPT 生成", formatWord: "PPT" },
  docx: { title: "Word 文档生成", formatWord: "Word 文档" },
  pdf: { title: "PDF 文档生成", formatWord: "PDF" },
  xlsx: { title: "Excel 生成", formatWord: "Excel" },
  copy: { title: "文案制作", formatWord: "" },
}

/** 海报制作占位:诚实说明,不放假按钮。 */
export function makePosterCard(): object {
  return statusCard(
    "🖼️ 海报制作",
    "海报自动生成(排版 + 配图)正在建设中,暂未开放。\n现阶段可以先让我产出**海报文案与排版说明**(走「文案制作」),再交给设计工具或同事出图。",
    "orange",
  )
}

/**
 * 制作表单:指令 + 本地文件多选 + 模板选择(仅 PPT)+ 云文件链接(可选)。
 * 本地文件通过「拖到聊天窗发送 → 点刷新」进入勾选区;刷新按钮是表单提交,
 * 已填内容随 form_value 带回并重渲染回填,不会丢失。
 */
export function makeFormCard(data: MakeFormData, preset?: MakeFormPreset, nonce = nextFormNonce()): object {
  const copy = MAKE_COPY[data.format]
  const elements: object[] = []

  elements.push({
    tag: "input",
    name: "instruction",
    width: "fill",
    input_type: "multiline_text",
    rows: 3,
    max_length: 500,
    default_value: preset?.instruction,
    placeholder: {
      tag: "plain_text",
      content:
        data.format === "pptx"
          ? "具体指令,如:做一份 FTTR 家庭组网方案的商业计划书 PPT,10 页以内,面向内部评审"
          : data.format === "xlsx"
            ? "具体指令,如:把上传的销售记录整理成月度对账 Excel,含明细 sheet、汇总 sheet 和图表"
            : data.format === "copy"
              ? "具体指令,如:写一篇 5G 新通话的公众号推文,800 字,语气轻快"
              : "具体指令,如:把上传的材料整理成一份产品请示文档,包含背景、方案、预算",
      },
  })

  if (data.files.length > 0) {
    elements.push({ tag: "markdown", content: "**资料文件**(可多选)" })
    elements.push(
      multiSelectStatic(
        "files",
        "选择文件",
        data.files.map((file) => selectOption(file.label, file.value)),
        preset?.files,
      ),
    )
  } else {
    elements.push({
      tag: "markdown",
      content: "<font color='grey'>资料文件:点下方「添加本地文件」,用 + 号发送后自动勾选。</font>",
      text_size: "notation",
    })
  }

  if (data.format === "pptx") {
    const templateOptions = [
      selectOption("不使用模板", ""),
      ...data.personalTemplates.map((name) => selectOption(`【我的】${name}`, name)),
      ...data.sharedTemplates.map((name) => selectOption(`【共享】${name}`, name)),
    ]
    elements.push({ tag: "markdown", content: "**模板**" })
    elements.push(selectStatic("template", "选择模板", templateOptions, preset?.template ?? ""))
  }

  elements.push({
    tag: "input",
    name: "cloud",
    width: "fill",
    default_value: preset?.cloud,
    placeholder: { tag: "plain_text", content: "云文件链接(可选),如 https://xxx.feishu.cn/file/abc123…" },
  })

  elements.push({ tag: "hr" })
  elements.push(
    buttonRow([
      formSubmitButton("开始生成", { n: nonce, k: "make-sub", f: data.format }, "primary", "submit"),
      formSubmitButton("添加本地文件", { n: nonce, k: "make-addfile", f: data.format }, "default", "addfile"),
      formSubmitButton("刷新文件列表", { n: nonce, k: "make-refresh", f: data.format }, "default", "refresh"),
      formSubmitButton("取消", { n: nonce, k: "make-cancel", f: data.format }, "default", "cancelmake"),
    ]),
  )
  return baseCard(copy.title, "blue", [{ tag: "form", name: "make_form", elements }])
}

/** 提交成功后替换表单卡的确认卡。 */
export function makeSubmittedCard(format: MakeFormat, instruction: string, fileCount: number, template: string): object {
  const lines = [`指令:${instruction.slice(0, 80)}${instruction.length > 80 ? "…" : ""}`]
  if (fileCount > 0) lines.push(`资料:${fileCount} 个文件`)
  if (template) lines.push(`模板:${template}`)
  return statusCard(
    `✅ ${MAKE_COPY[format].title}已提交`,
    `${lines.join("\n")}\n\n生成完成后文件会直接发到本会话。`,
    "green",
  )
}

/**
 * 创作工作台预览，功能与网页端一致：文案、海报、电商套图。
 * 没有风格、比例或模板选择。私聊发送「创作工作台」打开。
 */
export const STUDIO_POINTS = 120
export const STUDIO_COST = 10

export type StudioKind = "copy" | "poster" | "commerce"

const STUDIO_ACTIONS: Array<{ kind: StudioKind; label: string; placeholder: string }> = [
  { kind: "copy", label: "文案创作", placeholder: "描述要写的文案" },
  { kind: "poster", label: "海报生成", placeholder: "描述要生成的海报" },
  { kind: "commerce", label: "电商套图", placeholder: "描述要生成的电商套图" },
]

export function studioKindFrom(value: string | undefined): StudioKind {
  return STUDIO_ACTIONS.some((item) => item.kind === value) ? (value as StudioKind) : "copy"
}

function studioAction(kind: StudioKind): { kind: StudioKind; label: string; placeholder: string } {
  return STUDIO_ACTIONS.find((item) => item.kind === kind) ?? STUDIO_ACTIONS[0]!
}

export interface StudioDraft {
  kind: StudioKind
  prompt?: string
  product?: string
  channel?: string
  language?: string
  words?: string
  scene?: string
  selling?: string
  platform?: string
  tone?: string
  notice?: string
}

const STUDIO_CHANNELS = [
  "淘宝/天猫",
  "京东",
  "拼多多",
  "抖音电商",
  "Shopee",
  "Lazada",
  "Amazon",
  "Temu",
  "小红书",
  "Instagram",
  "朋友圈",
  "抖音封面",
  "TikTok",
  "快手",
  "公众号封面",
  "通用电商",
]
const STUDIO_LANGUAGES = ["繁体中文", "简体中文"]
const STUDIO_PLATFORMS = ["Facebook", "Instagram", "Twitter", "YouTube", "小红书", "知乎", "微博", "短视频脚本", "推广短信", "公众号"]
const STUDIO_TONES = ["广东粤语", "内地普通话", "英语"]

export function studioCard(draft: StudioDraft = { kind: "copy" }): object {
  const nonce = nextFormNonce()
  const kind = draft.kind
  const action = studioAction(kind)
  const pick = (item: (typeof STUDIO_ACTIONS)[number]) =>
    formSubmitButton(
      item.kind === kind ? `● ${item.label}` : item.label,
      { n: nonce, k: "studio", d: item.kind },
      item.kind === kind ? "primary" : "default",
      `pick_${item.kind}`,
    )
  const elements: object[] = [
    { tag: "markdown", content: `**积分余额：${STUDIO_POINTS}**` },
    { tag: "markdown", content: "**选择功能**" },
    buttonRow(STUDIO_ACTIONS.map(pick)),
    { tag: "markdown", content: `**${action.label}**` },
  ]
  if (kind === "commerce") {
    elements.push({
      tag: "input",
      name: "product",
      width: "fill",
      default_value: draft.product,
      placeholder: { tag: "plain_text", content: "产品名称，如：轻便拖鞋" },
    })
    elements.push({ tag: "markdown", content: "**渠道**" })
    elements.push(
      selectStatic(
        "channel",
        "选择渠道",
        STUDIO_CHANNELS.map((name) => selectOption(name, name)),
        draft.channel ?? "淘宝/天猫",
      ),
    )
    elements.push({ tag: "markdown", content: "**语言**" })
    elements.push(
      selectStatic(
        "language",
        "选择语言",
        STUDIO_LANGUAGES.map((name) => selectOption(name, name)),
        draft.language ?? "繁体中文",
      ),
    )
  } else if (kind === "copy") {
    elements.push({ tag: "markdown", content: "**场景需求**" })
    elements.push({
      tag: "input",
      name: "scene",
      width: "fill",
      default_value: draft.scene,
      placeholder: { tag: "plain_text", content: "填写使用场景" },
    })
    elements.push({ tag: "markdown", content: "**产品名称**" })
    elements.push({
      tag: "input",
      name: "product",
      width: "fill",
      default_value: draft.product,
      placeholder: { tag: "plain_text", content: "填写产品名称" },
    })
    elements.push({ tag: "markdown", content: "**核心卖点/促销优惠信息**" })
    elements.push({
      tag: "input",
      name: "selling",
      width: "fill",
      default_value: draft.selling,
      placeholder: { tag: "plain_text", content: "可不填" },
    })
    elements.push({ tag: "markdown", content: "**平台选择**" })
    elements.push(
      selectStatic(
        "platform",
        "选择平台",
        STUDIO_PLATFORMS.map((name) => selectOption(name, name)),
        draft.platform ?? "Twitter",
      ),
    )
    elements.push({ tag: "markdown", content: "**语言风格**" })
    elements.push(
      selectStatic(
        "tone",
        "选择语言风格",
        STUDIO_TONES.map((name) => selectOption(name, name)),
        draft.tone ?? "广东粤语",
      ),
    )
    elements.push({ tag: "markdown", content: "**输出字数**" })
    elements.push({
      tag: "input",
      name: "words",
      width: "fill",
      default_value: draft.words || "200",
      placeholder: { tag: "plain_text", content: "例如 200" },
    })
  } else {
    elements.push({
      tag: "input",
      name: "prompt",
      width: "fill",
      input_type: "multiline_text",
      rows: 3,
      max_length: 500,
      default_value: draft.prompt,
      placeholder: { tag: "plain_text", content: action.placeholder },
    })
  }
  if (draft.notice) elements.push({ tag: "markdown", content: `<font color='orange'>${escapeMarkdown(draft.notice)}</font>` })
  elements.push({ tag: "markdown", content: `本次生成预计消耗：**${STUDIO_COST}** 积分` })
  elements.push(buttonRow([formSubmitButton("开始生成", { n: nonce, k: "studio", d: "start", f: kind }, "primary", "start")]))
  return baseCard("AI 创作工作台", "blue", [{ tag: "form", name: "studio_form", elements }])
}

export function studioPendingCard(): object {
  return statusCard("AI 创作工作台", "正在生成中，请稍候。完成后这张卡片会自动更新。", "turquoise")
}

export function studioResultCard(draft: StudioDraft): object {
  const nonce = nextFormNonce()
  const left = Math.max(0, STUDIO_POINTS - STUDIO_COST)
  const action = studioAction(draft.kind)
  const detail =
    draft.kind === "commerce"
      ? `产品：${escapeMarkdown(draft.product ?? "")}\n渠道：${escapeMarkdown(draft.channel ?? "淘宝/天猫")}\n语言：${escapeMarkdown(draft.language ?? "繁体中文")}`
      : draft.kind === "copy"
        ? [
            `场景需求：${escapeMarkdown(draft.scene ?? "")}`,
            `产品名称：${escapeMarkdown(draft.product ?? "")}`,
            `核心卖点：${escapeMarkdown(draft.selling?.trim() ? draft.selling : "未填写")}`,
            `平台：${escapeMarkdown(draft.platform ?? "Twitter")}`,
            `语言风格：${escapeMarkdown(draft.tone ?? "广东粤语")}`,
            `输出字数：${escapeMarkdown(draft.words || "200")}`,
          ].join("\n")
        : escapeMarkdown(draft.prompt ?? "")
  return baseCard(`${action.label}结果`, "green", [
    {
      tag: "markdown",
      content: `**${action.label}**\n\n${detail}\n\n<font color='grey'>网页接口还没接上，这里先回显你填的内容。</font>`,
    },
    { tag: "markdown", content: `本次消耗 ${STUDIO_COST} 积分，剩余可用积分：${left}。` },
    buttonRow([
      callbackButton(
        "修改内容",
        {
          n: nonce,
          k: "studio",
          d: "back",
          f: draft.kind,
          v: {
            prompt: draft.prompt ?? "",
            product: draft.product ?? "",
            channel: draft.channel ?? "",
            language: draft.language ?? "",
            words: draft.words ?? "",
            scene: draft.scene ?? "",
            selling: draft.selling ?? "",
            platform: draft.platform ?? "",
            tone: draft.tone ?? "",
          },
        },
        "primary",
      ),
    ]),
  ])
}

/** 验证码登录预览。文案改这里。私聊发送「验证码登录」打开。不会真正发送短信。 */
export interface LoginDraft {
  phone?: string
  code?: string
  notice?: string
  sent?: boolean
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "")
  if (digits.length < 7) return "已绑定"
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

export function loginCard(draft: LoginDraft = {}): object {
  const nonce = nextFormNonce()
  const elements: object[] = [
    { tag: "markdown", content: "检测到您尚未绑定网页端账号，请先验证手机号完成登录。" },
    { tag: "markdown", content: "**手机号**" },
    {
      tag: "input",
      name: "phone",
      width: "fill",
      default_value: draft.phone,
      placeholder: { tag: "plain_text", content: "请输入手机号" },
    },
    buttonRow([
      formSubmitButton(
        draft.sent ? "验证码已发送，请稍候再试" : "获取验证码",
        { n: nonce, k: "login", d: "sms" },
        draft.sent ? "default" : "primary",
        "send_code",
      ),
    ]),
    { tag: "markdown", content: "**验证码**" },
    {
      tag: "input",
      name: "code",
      width: "fill",
      max_length: 6,
      default_value: draft.code,
      placeholder: { tag: "plain_text", content: "请输入 6 位验证码" },
    },
  ]
  if (draft.notice) elements.push({ tag: "markdown", content: `<font color='orange'>${escapeMarkdown(draft.notice)}</font>` })
  elements.push(buttonRow([formSubmitButton("确认绑定并登录", { n: nonce, k: "login", d: "confirm" }, "primary", "confirm")]))
  return baseCard("账号绑定", "blue", [{ tag: "form", name: "login_form", elements }])
}

export function loginDoneCard(phone: string): object {
  return statusCard(
    "账号绑定成功",
    `当前积分：${STUDIO_POINTS}\n绑定手机号：${maskPhone(phone)}\n\n<font color='grey'>这是预览，手机号和验证码没有发给网页端。</font>`,
    "green",
  )
}

function selectStatic(name: string, placeholder: string, options: object[], initial?: string): object {
  const el: Record<string, unknown> = {
    tag: "select_static",
    name,
    width: "fill",
    placeholder: { tag: "plain_text", content: placeholder },
    options,
  }
  // Pre-select in edit mode. Unknown fields are ignored by Feishu, so this is
  // safe even on surfaces whose card runtime does not honour initial_option.
  if (initial !== undefined) el.initial_option = initial
  return el
}

const DOW_CN: Record<string, string> = { mon: "一", tue: "二", wed: "三", thu: "四", fri: "五", sat: "六", sun: "日" }

/** `45 10 * * thu` → `每周四 10:45`（只处理订阅入口自身生成的五段式）。 */
function humanSchedule(schedule: string): string {
  const [m, h, dom, , dow] = schedule.trim().split(/\s+/)
  const time = `${h}:${String(m).padStart(2, "0")}`
  if (dow === "mon-fri") return `每工作日 ${time}`
  if (dow && dow !== "*") return `每周${DOW_CN[dow] ?? dow} ${time}`
  if (dom && dom !== "*") return `每月 ${dom} 号 ${time}`
  return `每天 ${time}`
}

/** Reverse of humanSchedule's inputs: cron 五段式 → 表单默认值。 */
function scheduleToForm(schedule: string): { freq?: string; hour?: string; minute?: string } {
  const [m, h, dom, , dow] = schedule.trim().split(/\s+/)
  let freq: string | undefined
  if (dow === "mon-fri") freq = "workday"
  else if (dow && dow !== "*") freq = dow
  else if (dom && dom !== "*") freq = dom === "1" || dom === "15" ? `dom${dom}` : undefined
  else freq = "daily"
  return { freq, hour: h, minute: String(Number(m)) }
}

/** 时间下拉（订阅表单与邮件订阅表单共用）：小时 0-23，分钟 5 分钟一档。 */
function hourOptions(): object[] {
  return Array.from({ length: 24 }, (_, h) => selectOption(`${h} 时`, String(h)))
}
function minuteOptions(): object[] {
  return Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0")).map((m) => selectOption(`${m} 分`, String(Number(m))))
}

/**
 * 订阅表单卡：用户发「资讯订阅」弹出。频率/时间全部点选（option value 直接
 * 编码调度参数，提交零解析），内容自由填写；form 提交时 action.form_value
 * 带上全部字段值，由 interactions 的 cron-sub 分支组装成 cron 任务。
 * 传入 edit 时为编辑模式：预填原值，提交后替换原订阅（value.f 带原名）。
 */
/** 订阅频率选项：资讯/邮件订阅表单共用（value 对应 interactions 的 FREQ_TABLE）。 */
const FREQ_PAIRS: Array<[string, string]> = [
  ["每天", "daily"],
  ["每工作日（周一至周五）", "workday"],
  ["每周一", "mon"],
  ["每周二", "tue"],
  ["每周三", "wed"],
  ["每周四", "thu"],
  ["每周五", "fri"],
  ["每周六", "sat"],
  ["每周日", "sun"],
  ["每月 1 号", "dom1"],
  ["每月 15 号", "dom15"],
]

export function subscribeCard(edit?: CronJobInfo): object {
  const preset = edit ? scheduleToForm(edit.schedule) : {}
  const nonce = nextFormNonce()
  const freqOptions = FREQ_PAIRS.map(([label, value]) => selectOption(label, value))
  const elements: object[] = [
    {
      tag: "markdown",
      content: edit
        ? `正在编辑订阅 **${escapeMarkdown(edit.name)}**，调整后提交即可替换。`
        : "选择推送频率与时间、填写关注内容，我会按时把最新资讯推送到本会话。",
    },
    { tag: "markdown", content: "**📌 订阅内容**" },
    {
      tag: "input",
      name: "prompt",
      width: "fill",
      // 编辑「邮件日报」等系统预设订阅时 default_value 是一整段指令（130+ 字），
      // max_length 必须装得下，否则飞书拒绝渲染整张卡片，回调直接失败。
      max_length: 500,
      default_value: edit?.prompt,
      placeholder: { tag: "plain_text", content: "如：FTTR 相关资讯、香港教育产品动向" },
    },
    { tag: "markdown", content: "**🔁 推送频率**" },
    selectStatic("freq", edit ? `原频率：${humanSchedule(edit.schedule).replace(/\s+\d+:.*/, "")}` : "选择频率", freqOptions, preset.freq),
    { tag: "markdown", content: "**🕘 推送时间（24 小时制）**" },
    selectStatic("hour", edit ? `原时间：${humanSchedule(edit.schedule).match(/\d+:\d+$/)?.[0] ?? ""}` : "选择小时", hourOptions(), preset.hour),
    selectStatic("minute", "选择分钟", minuteOptions(), preset.minute),
    { tag: "hr" },
    {
      tag: "markdown",
      content: "<font color='grey'>更复杂的周期（如每月 20 号）可直接发文字：订阅 每月20号 9:00 内容</font>",
      text_size: "notation",
    },
    buttonRow([
      formSubmitButton(edit ? "✅ 保存修改" : "✅ 创建订阅", { n: nonce, k: "cron-sub", f: edit?.name }, "primary", "submit"),
      formSubmitButton("取消", { n: nonce, k: "cron-cancel", f: edit?.name, d: "资讯订阅" }, "default", "cancel"),
    ]),
  ]
  return baseCard(edit ? "✏️ 编辑订阅" : "⏰ 新增资讯订阅", "blue", [{ tag: "form", name: "cron_sub", elements }])
}

/**
 * 邮件类订阅判定：「邮件订阅」创建的管理任务名称固定含「邮件」、prompt 含 S64
 * 技能标识；用户文字订阅里名字带「邮件/邮箱」的也归入邮件组。其余算资讯订阅。
 */
export function isMailJob(job: CronJobInfo): boolean {
  return /邮件|邮箱/.test(job.name) || /S64|邮件查收/.test(job.prompt)
}

/** Stable per-user job name. The manage card shows it as 「邮件管理」. */
export function mailJobName(openId: string): string {
  return `邮件管理#${openId.slice(-8)}`
}

export function mailJobTitle(name: string): string {
  return name.startsWith("邮件管理#") ? "邮件管理" : name
}

/** 邮件订阅表单的编辑上下文：名称 + 原调度（日报逻辑固定，编辑只改频率/时间）。 */
export interface MailSubscribeEdit {
  name: string
  schedule: string
}

/**
 * 邮件订阅表单卡。第一次订阅要填自己的飞书邮箱；编辑已有订阅只改频率和时间。
 * 提交走 cron-mail-sub。
 */
export function mailSubscribeCard(edit?: MailSubscribeEdit, notice?: string): object {
  const preset = edit ? scheduleToForm(edit.schedule) : {}
  const nonce = nextFormNonce()
  const freqOptions = FREQ_PAIRS.map(([label, value]) => selectOption(label, value))
  const elements: object[] = [
    {
      tag: "markdown",
      content: edit
        ? `正在编辑 **${escapeMarkdown(mailJobTitle(edit.name))}**，调整后提交即可替换。邮箱沿用上次填写的，不用再填。`
        : "选择总结频率和时间，并填写**你自己的飞书邮箱**。日报只读这个邮箱：按时整理收件箱，**着重列出需要尽快回复的邮件、未来两周内有截止日期需要你处理的事项**；没有就直说没有。\n重要性「高」的新邮件会实时单独推送给你。",
    },
    { tag: "markdown", content: "**🔁 总结频率**" },
    selectStatic("freq", edit ? `原频率：${humanSchedule(edit.schedule).replace(/\s+\d+:.*/, "")}` : "选择频率", freqOptions, preset.freq),
    { tag: "markdown", content: "**🕘 推送时间（24 小时制）**" },
    selectStatic("hour", edit ? `原时间：${humanSchedule(edit.schedule).match(/\d+:\d+$/)?.[0] ?? ""}` : "选择小时", hourOptions(), preset.hour),
    selectStatic("minute", "选择分钟", minuteOptions(), preset.minute),
  ]
  if (!edit) {
    elements.push({ tag: "markdown", content: "**邮箱**" })
    elements.push({
      tag: "input",
      name: "email",
      width: "fill",
      placeholder: { tag: "plain_text", content: "填写你的飞书邮箱" },
    })
  }
  if (notice) {
    elements.push({
      tag: "markdown",
      content: `<font color='orange'>${escapeMarkdown(notice)}</font>`,
    })
  }
  elements.push(
    { tag: "hr" },
    {
      tag: "markdown",
      content: "<font color='grey'>总结范围随频率：每天一次总结前一天，每周一次总结前一周，每月一次总结前 30 天。邮箱必须是你飞书账号登记的企业邮箱。接口只读：不会删除、移动、标记或回复任何邮件。</font>",
      text_size: "notation",
    },
    buttonRow([
      formSubmitButton(edit ? "✅ 保存修改" : "✅ 开启邮件管理", { n: nonce, k: "cron-mail-sub", f: edit?.name }, "primary", "submit"),
      formSubmitButton("取消", { n: nonce, k: "cron-cancel", f: edit?.name, d: "邮件订阅" }, "default", "cancel"),
    ]),
  )
  return baseCard(edit ? "✏️ 编辑邮件管理" : "📮 新增邮件订阅", "blue", [{ tag: "form", name: "cron_mail_sub", elements }])
}

/** 订阅表单「取消」后的替换卡：编辑态确认原订阅未动，新建态给菜单指引。 */
export function cronFormCancelCard(editingName?: string, menuLabel?: string): object {
  const content = editingName
    ? `已取消编辑，**${escapeMarkdown(editingName)}** 保持原样不变。\n管理订阅：点击下方菜单「订阅 > 我的订阅」。`
    : `已取消，没有创建订阅。\n想重新开始：点击下方菜单「订阅 > ${menuLabel ?? "资讯订阅"}」。`
  return statusCard("已取消", content, "grey")
}

/** 订阅管理卡：按「邮件订阅 / 资讯订阅」分组，列表 + 暂停/编辑/删除，全部点选操作。 */
export function cronManageCard(jobs: CronJobInfo[]): object {
  // A fresh nonce per render keeps every button payload unique: the card is
  // updated in place after each action, and without it the SDK's 12h click
  // dedup would swallow the second click on the same toggle.
  const nonce = nextFormNonce()
  const elements: object[] = []
  if (jobs.length === 0) {
    elements.push({ tag: "markdown", content: "暂无订阅。\n点击下方菜单「订阅 > 资讯订阅」或「订阅 > 邮件订阅」即可创建。" })
  }
  const pushJob = (job: CronJobInfo, index: number) => {
    const status = job.enabled
      ? `🟢 ${humanSchedule(job.schedule)}${job.next ? ` · 下次 ${job.next}` : ""}${job.urgent ? " · 🔔加急" : ""}`
      : "⏸ 已暂停"
    // 邮件类订阅的 prompt 是一段技术性指令，主标题直接显示名称更友好；
    // 资讯订阅保持原样（prompt 截断为主标题，灰色小字显示名称）。
    const mail = isMailJob(job)
    const title = mail ? mailJobTitle(job.name) : job.prompt.slice(0, 40)
    const sub = mail ? escapeMarkdown(status) : `${escapeMarkdown(job.name)} · ${escapeMarkdown(status)}`
    elements.push({
      tag: "markdown",
      content: `**${index + 1}. ${escapeMarkdown(title)}**\n<font color='grey'>${sub}</font>`,
    })
    const buttons: object[] = [
      callbackButton(job.enabled ? "⏸ 暂停" : "▶ 恢复", { n: nonce, k: "cron-pause", d: job.name }, job.enabled ? "default" : "primary"),
      callbackButton(job.urgent ? "🔕 静音" : "🔔 提醒", { n: nonce, k: "cron-urgent", d: job.name }),
    ]
    if (job.enabled) buttons.push(callbackButton("✏️ 编辑", { n: nonce, k: "cron-edit", d: job.name }))
    buttons.push(callbackButton("🗑 删除", { n: nonce, k: "cron-del", d: job.name }, "danger"))
    elements.push(buttonRow(buttons))
  }
  const groups: Array<[string, CronJobInfo[]]> = [
    ["📮 邮件订阅", jobs.filter(isMailJob)],
    ["📰 资讯订阅", jobs.filter((j) => !isMailJob(j))],
  ]
  groups
    .filter(([, list]) => list.length > 0)
    .forEach(([title, list], gi) => {
      if (gi > 0) elements.push({ tag: "hr" })
      elements.push({ tag: "markdown", content: `**${title}**（${list.length}）` })
      list.forEach((job, i) => {
        pushJob(job, i)
        if (i < list.length - 1) elements.push({ tag: "hr" })
      })
    })
  if (jobs.length > 0) elements.push({ tag: "hr" })
  elements.push({
    tag: "markdown",
    content: "<font color='grey'>点击菜单「订阅 > 资讯订阅」或「订阅 > 邮件订阅」新建订阅 · 操作后列表即时刷新</font>",
    text_size: "notation",
  })
  return baseCard("📋 我的订阅", "blue", elements)
}

/** 删除二次确认卡。 */
export function cronDeleteConfirmCard(name: string): object {
  const nonce = nextFormNonce()
  return baseCard("🗑 删除订阅", "red", [
    { tag: "markdown", content: `确认删除订阅 **${escapeMarkdown(name)}**？删除后不可恢复。` },
    buttonRow([
      callbackButton("✅ 确认删除", { n: nonce, k: "cron-del-yes", d: name }, "danger"),
      callbackButton("↩ 返回列表", { n: nonce, k: "cron-mgr" }),
    ]),
  ])
}

// ---- 个性化技能 ------------------------------------------------------------

/** 技能表单的预填值（编辑时带 id）。 */
export interface SkillFormDraft {
  id?: string
  name?: string
  triggers?: string[]
  scene?: string
  steps?: string
  output?: string
  scope?: SkillScope
}

const SKILL_HINT =
  "<font color='grey'>技能只对你生效：聊天里出现触发词时自动套用，也可以随时发「技能」打开这张卡管理。</font>"

function skillRow(skill: Skill): object[] {
  return [
    { tag: "markdown", content: describeSkill(skill) },
    buttonRow([
      callbackButton("✏️ 编辑", { k: "skill-edit", d: skill.id }),
      callbackButton("🗑 删除", { k: "skill-del", d: skill.id }, "danger"),
      callbackButton("▶ 试用", { k: "skill-use", d: skill.id }, "primary"),
    ]),
  ]
}

/** 技能管理卡：个人 + 共享分组，逐条可编辑/删除/试用。 */
export function skillManageCard(skills: Skill[], isAdmin: boolean): object {
  const personal = skills.filter((skill) => skill.scope === "personal")
  const shared = skills.filter((skill) => skill.scope === "shared")
  const elements: object[] = [
    {
      tag: "markdown",
      content:
        "把你的做法写成一条**技能**：说清什么时候用、怎么做、要什么结果。以后在聊天里提到触发词，我就按它来做。",
    },
    { tag: "hr" },
  ]

  if (personal.length === 0 && shared.length === 0) {
    elements.push({
      tag: "markdown",
      content: "还没有技能。点下面的「新建技能」，一两分钟就能攒出第一条。",
    })
  }

  if (personal.length > 0) {
    elements.push({ tag: "markdown", content: `**我的技能（${personal.length}）**` })
    for (const skill of personal) elements.push(...skillRow(skill))
    elements.push({ tag: "hr" })
  }

  if (shared.length > 0) {
    elements.push({ tag: "markdown", content: `**共享技能（${shared.length}）**` })
    for (const skill of shared) elements.push(...skillRow(skill))
    elements.push({ tag: "hr" })
  }

  elements.push(
    buttonRow([
      callbackButton("➕ 新建技能", { k: "skill-new" }, "primary"),
      callbackButton("🔄 刷新", { k: "skill-mgr" }),
    ]),
  )
  elements.push({
    tag: "markdown",
    content: isAdmin
      ? `${SKILL_HINT}\n<font color='grey'>你是管理员：新建时可以把技能设为「共享」，全员的会话都能用。</font>`
      : SKILL_HINT,
    text_size: "notation",
  })
  return baseCard("🧩 我的技能", "blue", elements)
}

const SCOPE_OPTIONS = (isAdmin: boolean): object[] =>
  isAdmin
    ? [selectOption("仅自己可用", "personal"), selectOption("共享给全员（管理员）", "shared")]
    : [selectOption("仅自己可用", "personal")]

/** 技能表单卡：新建 / 编辑共用。 */
export function skillFormCard(draft: SkillFormDraft = {}, options: { isAdmin: boolean } = { isAdmin: false }): object {
  const elements: object[] = [
    {
      tag: "markdown",
      content: draft.id
        ? "改完点「保存」，下一条消息起按新版本执行。"
        : "**触发词**决定什么时候自动套用；**执行步骤**写得越像操作手册，效果越稳。",
    },
  ]

  elements.push({ tag: "markdown", content: "**技能名称**\n例：竞品周报、客户拜访纪要、周会材料" })
  elements.push({
    tag: "input",
    name: "name",
    width: "fill",
    max_length: 24,
    default_value: draft.name,
    placeholder: { tag: "plain_text", content: "一句话叫得出名字，2–24 字" },
  })

  elements.push({
    tag: "markdown",
    content: "**触发词**\n我听到这些词就套用这条技能，空格或逗号分隔，最多 8 个",
  })
  elements.push({
    tag: "input",
    name: "triggers",
    width: "fill",
    max_length: 200,
    default_value: (draft.triggers ?? []).join(" "),
    placeholder: { tag: "plain_text", content: "如：竞品周报 竞品每周 对手动态汇总" },
  })

  elements.push({ tag: "markdown", content: "**适用场景**（可选）\n这条技能是给哪类活儿用的" })
  elements.push({
    tag: "input",
    name: "scene",
    width: "fill",
    max_length: 200,
    default_value: draft.scene,
    placeholder: { tag: "plain_text", content: "如：每周给部门领导看的竞品动态汇总" },
  })

  elements.push({
    tag: "markdown",
    content: "**执行步骤与要求**\n按你希望的做法写：先查什么、怎么对比、忌讳什么",
  })
  elements.push({
    tag: "input",
    name: "steps",
    width: "fill",
    input_type: "multiline_text",
    rows: 6,
    // 飞书对 input.max_length 的上限是 1000，写大了整张卡片会被拒（230099 / 11310）。
    max_length: 1000,
    default_value: draft.steps,
    placeholder: {
      tag: "plain_text",
      content:
        "如：1. 只取最近 7 天的动态，来源优先官网和行业媒体；2. 按「产品/价格/渠道」三段对比我们和对手；3. 结论不超过 5 条，每条一句话；4. 不确定的信息标注「待核实」，不要编数字。",
    },
  })

  elements.push({ tag: "markdown", content: "**输出要求**（可选）\n格式、篇幅、语气" })
  elements.push({
    tag: "input",
    name: "output",
    width: "fill",
    max_length: 300,
    default_value: draft.output,
    placeholder: { tag: "plain_text", content: "如：Markdown 表格 + 3 条结论，500 字以内，给领导看" },
  })

  if (options.isAdmin) {
    elements.push({ tag: "markdown", content: "**谁能用**" })
    elements.push(selectStatic("scope", "选择可见范围", SCOPE_OPTIONS(true), draft.scope ?? "personal"))
  }

  const nonce = nextFormNonce()
  elements.push({ tag: "hr" })
  elements.push(
    buttonRow([
      formSubmitButton("✅ 保存技能", { n: nonce, k: "skill-save", d: draft.id }, "primary", "submit"),
      formSubmitButton("取消", { n: nonce, k: "skill-cancel" }, "default", "cancel"),
    ]),
  )
  return baseCard(draft.id ? "✏️ 编辑技能" : "🧩 新建技能", "blue", [{ tag: "form", name: "skill_form", elements }])
}

/** 保存成功卡：直接给「试用」，省得用户再想怎么触发。 */
export function skillSavedCard(skill: Skill, isAdmin: boolean): object {
  const nonce = nextFormNonce()
  const elements: object[] = [
    { tag: "markdown", content: describeSkill(skill) },
    {
      tag: "markdown",
      content:
        skill.scope === "shared"
          ? "全员都可以用这条技能了。想验证效果，点「试用」我立刻按它跑一次。"
          : "以后聊天里出现这些触发词，我就会按它来做。想验证效果，点「试用」我立刻按它跑一次。",
    },
    buttonRow([
      callbackButton("▶ 试用", { n: nonce, k: "skill-use", d: skill.id }, "primary"),
      callbackButton("➕ 再建一条", { n: nonce, k: "skill-new" }),
      callbackButton("📋 技能列表", { n: nonce, k: "skill-mgr" }),
    ]),
  ]
  if (!isAdmin) elements.push({ tag: "markdown", content: SKILL_HINT, text_size: "notation" })
  return baseCard("✅ 技能已保存", "green", elements)
}

/** 删除二次确认。 */
export function skillDeleteConfirmCard(skill: Skill): object {
  const nonce = nextFormNonce()
  return baseCard("🗑 删除技能", "red", [
    { tag: "markdown", content: `确认删除技能 **${escapeMarkdown(skill.name)}**？删除后不可恢复。` },
    buttonRow([
      callbackButton("✅ 确认删除", { n: nonce, k: "skill-del-yes", d: skill.id }, "danger"),
      callbackButton("↩ 返回列表", { n: nonce, k: "skill-mgr" }),
    ]),
  ])
}

export function helpCard(): object {
  const commands = [
    "**新建对话** — 点击下方菜单，开启一个全新会话",
    "**停止生成** — 点击下方菜单，停掉正在进行的任务",
    "**资讯订阅** — 点击菜单「订阅 > 资讯订阅」，在弹出的卡片里点选频率、时间并填写内容即可\n  也可直接发文字：订阅 每周一 9:00 FTTR 相关资讯",
    "**邮件订阅** — 点击菜单「订阅 > 邮件订阅」。第一次要填写你自己的飞书邮箱，之后只读这个邮箱；编辑已有订阅不用再填邮箱。按时整理收件箱，重要邮件实时推送给你",
    "**我的订阅** — 点击菜单「订阅 > 我的订阅」弹出管理卡片：查看全部订阅，可暂停 / 恢复 / 编辑 / 删除",
    "**模板库** — 发送「模板库」查看 PPT 模板（发 .pptx 并写「存为模板 名字」可新增）",
    "**我的技能** — 发「技能」打开管理卡片：卡片里填名称、触发词、执行步骤与输出要求，保存即生效\n  以后聊天里出现触发词就会自动按这条技能执行；也可用「用XX技能」显式指定",
    "**帮助** — 点击下方菜单，显示本帮助",
  ]
  return baseCard("🤖 产品中心智能助手", "blue", [
    { tag: "markdown", content: "我可以把你的消息转发给产品中心智能助手，并实时流式回复。\n\n**支持：**\n- 文本、图片、文件（图片/文本会作为上下文附件）\n- 交互式卡片授权与提问\n- 每个会话独立目录，上下文互不干扰\n- 定时任务、会话迁移" },
    { tag: "hr" },
    { tag: "markdown", content: commands.map((c) => `- ${c}`).join("\n") },
  ])
}
