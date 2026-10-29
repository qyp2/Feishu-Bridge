/**
 * 回归校验：prompt 接口的 files[] 必须是 `PromptInput.FileAttachment`，即只带 `uri`。
 *
 * 这里不真跑模型：拿一个不存在的 sessionID 发同一个请求体。
 * - schema 不合规 → 400 Missing key at ["files"][0][...]
 * - schema 合规   → 只是 404/找不到会话
 * 所以只要错误里没有 "Missing key"，就说明附件形状是对的。
 *
 * 背景：早期版本要求客户端自带 {data, mime, source}，升级后那套形状会被拒。
 *
 * 用法：node scripts/verify-image-attachment.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfig } from "../dist/config/index.js"
import { OpencodeService } from "../dist/opencode/service.js"
import { Logger } from "../dist/util/logger.js"

// 1x1 红色 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

const { config } = loadConfig()
const service = new OpencodeService(config.opencode, new Logger({ level: "error", pretty: true, name: "verify-image" }))
const client = await service.client()

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-file-"))
const file = path.join(dir, "probe image.png") // 故意带空格，验证百分号编码
fs.writeFileSync(file, PNG)

let failures = 0
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  PASS  ${label}`)
  else {
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`)
    failures++
  }
}

let message = ""
try {
  // sessionID 故意不存在；只关心 schema 是否通过
  await client.prompt("ses_00000000000000000000000000", {
    text: "附件形状校验",
    files: [{ uri: pathToFileURL(file).href, name: "probe.png" }],
  })
} catch (error) {
  message = error instanceof Error ? error.message : String(error)
}

check("请求体通过 schema 校验", !/Missing key/i.test(message), message)
check("没有落到 500（形状本身能解析）", !/500/.test(message), message)
if (message) console.log(`  info  服务端返回：${message.slice(0, 160)}`)

fs.rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\n结果：通过（附件只带 uri，服务端接受）" : `\n结果：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
