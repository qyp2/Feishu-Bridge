import fs from "node:fs"
import path from "node:path"

const START = "<!-- feishu-bridge:start -->"
const END = "<!-- feishu-bridge:end -->"

const BRIDGE_BLOCK = `${START}
# Feishu 桥接说明

你正在通过飞书机器人与用户对话。请遵守以下约定：

- 回复使用简洁的 Markdown；飞书会自动渲染。
- 如非用户明确要求英文，请使用简体中文回答。
- 飞书卡片会按层展示处理过程。不要在回复里写调用链路，也不要逐条播报子 Agent 的开始和完成。最终回复只写给用户的结论。
- 不要写「先暂停」，不要把任务移到后台。
- 需要向用户发送文件时，把文件放在 \`deliverables/\` 下，并在最终回复里单独一行输出：
  - \`[[send-file: /绝对路径/文件名]]\`
  桥接会移除这行指令，并把文件发送到飞书。\`deliverables/\` 里本次新写的文件也会被发送。
- 生成 PPT、Word、Excel 或 PDF 时，同目录下的 \`.md\` 只是中间稿：不要给它写 send-file 标记，最终回复只给成品（.pptx/.docx/.xlsx/.pdf）的标记和路径。只有用户明确要 Markdown 时才发送 \`.md\`。
- 信息不足时在最终回复里写明假设。不要停下来向用户提问。
${END}`

/** Ensure the bridge instruction block exists in the directory's AGENTS.md. */
export function ensureInstructions(directory: string): void {
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, "AGENTS.md")
  let content = ""
  try {
    content = fs.readFileSync(file, "utf8")
  } catch {
    content = ""
  }
  const start = content.indexOf(START)
  const end = content.indexOf(END)
  let next: string
  if (start !== -1 && end !== -1 && end > start) {
    next = content.slice(0, start) + BRIDGE_BLOCK + content.slice(end + END.length)
  } else {
    next = (content.trim().length > 0 ? content.trimEnd() + "\n\n" : "") + BRIDGE_BLOCK + "\n"
  }
  if (next !== content) fs.writeFileSync(file, next, "utf8")
}

export interface OutgoingFile {
  kind: "file" | "image"
  path: string
}

const MARKER = /\[\[\s*send-(file|image)\s*:\s*([^\]]+?)\s*\]\]/gi

/** Extract outgoing file directives from assistant text, returning clean text. */
export function extractFileMarkers(text: string): { text: string; files: OutgoingFile[] } {
  const files: OutgoingFile[] = []
  const clean = text.replace(MARKER, (_match, kind: string, target: string) => {
    files.push({ kind: kind.toLowerCase() === "image" ? "image" : "file", path: target.trim() })
    return ""
  })
  return { text: clean.replace(/\n{3,}/g, "\n\n").trim(), files }
}
