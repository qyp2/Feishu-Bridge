/** Commands that change the bot's local runtime, not a user's document task. */
const CONFIG_COMMANDS = new Set(["agent", "model", "import"])

const CONFIG_PATH =
  /(?:^|[\s`"'「」/\\])(?:agent\.md|agents\.md|opencode\.jsonc?|config\.json)(?=$|[\s`"'」])/i

const WRITE_VERB = /写进|写入|写到|改成|修改|更改|编辑|替换|覆盖|追加|overwrite|modify/i

/**
 * A group message asking to change this machine's agent or config files.
 * Ordinary product tasks ("写一份配置方案") do not match.
 */
export function asksToChangeLocalConfig(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  if (/修改本地配置|改本地配置|更改本地配置|修改配置文件|改配置文件|编辑配置文件/.test(value)) return true
  if (CONFIG_PATH.test(value) && WRITE_VERB.test(value)) return true
  if (/(?:修改|更改|编辑|写入|写进|覆盖).{0,12}(?:\.opencode|opencode\.json|agent\s*定义|系统提示词)/i.test(value)) {
    return true
  }
  return false
}

export function isConfigCommand(command: string): boolean {
  return CONFIG_COMMANDS.has(command)
}

/** Tool targets that are this deployment's own config, not a generated deliverable. */
export function isProtectedConfigTarget(resource: string): boolean {
  const value = resource.replace(/\\/g, "/").toLowerCase()
  if (!value || value === "*") return false
  return (
    value.includes("/.opencode/") ||
    value.endsWith("/.opencode") ||
    value.includes("opencode.json") ||
    value.includes("/config/config.json") ||
    value.endsWith("/agent.md") ||
    value.endsWith("/agents.md") ||
    value.includes("/feishu_bridge/config/") ||
    value.includes("/feishu_bridge/src/") ||
    value.includes("/.cursor/")
  )
}

export const CONFIG_CHANGE_DENIED =
  "群里不能修改本地配置。Agent 定义、模型、opencode 配置、config.json 和 .opencode 下的文件都不能改。"
