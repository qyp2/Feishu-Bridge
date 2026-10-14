/**
 * Manual smoke test for the OpenCode connection.
 *
 * Creates a throwaway session, sends a prompt, prints streaming text deltas and
 * exits. Run with:  npx tsx scripts/smoke.ts
 */
import path from "node:path"
import fs from "node:fs"
import { OpencodeService } from "../src/opencode/service.js"
import { Logger } from "../src/util/logger.js"

const logger = new Logger({ level: "info", pretty: true, name: "smoke" })

const cfg = {
  mode: "service" as const,
  baseUrl: "http://127.0.0.1:4096",
  password: "",
  location: process.cwd(),
  dataDir: "D:/myapp/feishu-bridge/.opencode",
  servicePort: 0,
  serviceCommand: ["opencode", "serve", "--service"],
  restartCommand: ["opencode", "service", "restart"],
  healthIntervalMs: 30_000,
  healthTimeoutMs: 8_000,
  restartOnFailure: false,
  failureThreshold: 3,
}

async function main(): Promise<void> {
  const service = new OpencodeService(cfg, logger)
  const client = await service.client()
  const info = await client.info()
  console.log("Connected:", client.baseUrl, "version", info.version)

  const dir = path.join("D:/myapp/agent demo", "产品中心agent", "smoke-test")
  fs.mkdirSync(dir, { recursive: true })
  console.log("Session dir:", dir)

  const session = await client.createSession({
    title: "smoke test",
    directory: dir,
    agent: "pm-brain",
    model: { providerID: "myapi", id: "deepseek-v4-free", variant: "high" },
  })
  console.log("Session:", session.id, "agent:", session.agent, "model:", JSON.stringify(session.model))

  const ac = new AbortController()
  let text = ""
  const done = new Promise<void>((resolve) => {
    void (async () => {
      for await (const event of client.streamEvents(ac.signal)) {
        const data = event.data as Record<string, unknown>
        if (data.sessionID && data.sessionID !== session.id) continue
        if (event.type === "session.text.delta") {
          process.stdout.write(String(data.delta ?? ""))
          text += String(data.delta ?? "")
        } else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") {
          console.log(`\n[${event.type}]`, JSON.stringify(data))
          ac.abort()
          resolve()
        }
      }
    })().catch(() => resolve())
  })

  await client.prompt(session.id, { text: "用一句中文打个招呼。", delivery: "queue" })
  await Promise.race([done, new Promise((r) => setTimeout(r, 120_000))])

  console.log("\n--- final text ---\n" + text)
  await client.deleteSession(session.id).catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

main().catch((error) => {
  console.error("smoke failed:", error)
  process.exit(1)
})
