#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./config/index.js"
import { App } from "./app.js"
import { OpencodeService } from "./opencode/service.js"
import { Logger } from "./util/logger.js"
import { ensureDir } from "./util/paths.js"

function printUsage(): void {
  process.stdout.write(
    [
      "feishu-bridge — 将 OpenCode 接入飞书机器人",
      "",
      "用法：",
      "  feishu-bridge [run] [--config <path>]   启动桥接服务（默认）",
      "  feishu-bridge doctor [--config <path>]  只做配置与 OpenCode 连通性检查",
      "  feishu-bridge init [--config <path>]    生成配置示例（如不存在）",
      "",
      "环境变量：FEISHU_BRIDGE_CONFIG, OPENCODE_PASSWORD, OPENCODE_BASE_URL,",
      "          BOT_<NAME>_APP_ID, BOT_<NAME>_APP_SECRET",
      "",
    ].join("\n"),
  )
}

function parseArgs(argv: string[]): { command: string; config?: string } {
  const args = argv.slice(2)
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "run"
  let config: string | undefined
  const idx = args.indexOf("--config")
  if (idx !== -1) config = args[idx + 1]
  return { command, config }
}

/** Copy the bundled config example next to the target config path. */
function runInit(configPath?: string): void {
  const target = path.resolve(configPath ?? process.env.FEISHU_BRIDGE_CONFIG ?? path.join("config", "config.json"))
  if (fs.existsSync(target)) {
    process.stdout.write(`配置已存在，未覆盖：${target}\n`)
    return
  }
  // Look for the example in a few likely locations (dev checkout vs installed).
  const candidates = [
    path.join(process.cwd(), "config", "config.example.json"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "config.example.json"),
  ]
  const example = candidates.find((p) => fs.existsSync(p))
  if (!example) {
    process.stderr.write("找不到 config.example.json，请手动创建配置文件。\n")
    process.exit(1)
  }
  ensureDir(path.dirname(target))
  fs.copyFileSync(example, target)
  process.stdout.write(`已生成配置：${target}\n请填写 appId/appSecret 后运行：npm run dev\n`)
}

async function runDoctor(configPath?: string): Promise<void> {
  const loaded = loadConfig(configPath)
  const { config } = loaded
  process.stdout.write(`配置加载成功：${loaded.file}\n`)
  process.stdout.write(`机器人 (${config.bots.length})：${config.bots.map((b) => b.name).join(", ")}\n`)
  process.stdout.write(`存储目录：${config.storageDir}\n`)

  const placeholders = config.bots.filter(
    (b) => /^cli_x+$/i.test(b.appId) || /^x+$/i.test(b.appSecret) || !b.appId || !b.appSecret,
  )
  if (placeholders.length > 0) {
    process.stdout.write(`警告：以下机器人仍是占位凭据，请填写真实 appId/appSecret：${placeholders.map((b) => b.name).join(", ")}\n`)
  }

  const logger = new Logger({ level: config.logLevel, pretty: true, name: "doctor" })
  const service = new OpencodeService(config.opencode, logger)
  const health = await service.health()
  if (health.ok) {
    process.stdout.write(`OpenCode 连接正常：version ${health.info?.version}，pid ${health.info?.pid}\n`)
  } else {
    process.stdout.write(`OpenCode 连接失败：${health.error}\n`)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  const { command, config } = parseArgs(process.argv)

  if (command === "help" || command === "-h" || command === "--help") {
    printUsage()
    return
  }

  if (command === "init") {
    runInit(config)
    return
  }

  if (command === "doctor") {
    await runDoctor(config)
    return
  }

  const loaded = loadConfig(config)
  const app = new App(loaded)
  await app.start()

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\n收到 ${signal}，正在退出…\n`)
    await app.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

main().catch((error) => {
  process.stderr.write(`启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
