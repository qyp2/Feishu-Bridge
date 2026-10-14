import fs from "node:fs"
import path from "node:path"

const START = "<!-- feishu-bridge:start -->"
const END = "<!-- feishu-bridge:end -->"

const BRIDGE_BLOCK = `${START}
# Feishu 桥接说明

你正在通过飞书机器人与用户对话。请遵守以下约定：

- 回复使用简洁的 Markdown；飞书会自动渲染。
- 如非用户明确要求英文，请使用简体中文回答。
- 需要向用户发送文件或截图时，把文件写入当前工作目录，然后在回复正文中单独一行输出下面任一指令：
  - \`[[send-file: /绝对路径/文件名]]\` —— 发送任意文件
  - \`[[send-image: /绝对路径/图片.png]]\` —— 作为图片发送
  桥接会移除这些指令，并把文件真实发送到飞书。
- 需要用户做出选择时，优先使用内置的提问（question）工具，桥接会把问题渲染成飞书交互卡片。
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
