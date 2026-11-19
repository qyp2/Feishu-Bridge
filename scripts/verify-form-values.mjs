/**
 * 卡片 form_value 解析（不触网）。
 *
 * 用法：node scripts/verify-form-values.mjs
 */
import { fileURLToPath } from "node:url"
import path from "node:path"
import { extractFormValues, formFieldString } from "../dist/feishu/formValues.js"

const here = path.dirname(fileURLToPath(import.meta.url))
process.chdir(path.resolve(here, ".."))

let failures = 0
function check(label, condition, detail = "") {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`)
    failures++
  }
}

const nested = {
  operator: { open_id: "ou_x" },
  action: {
    tag: "button",
    name: "submit",
    value: { k: "skill-save", n: 1 },
    form_value: {
      skill_name: "竞品周报",
      triggers: "竞品 周报",
      steps: "先查官网再汇总",
    },
  },
}

const evt = {
  messageId: "om_x",
  chatId: "oc_x",
  operator: { openId: "ou_x" },
  action: { tag: "button", name: "submit", value: { k: "skill-save" } },
  raw: nested,
}

const values = extractFormValues(evt)
check("读到 skill_name", values.skill_name === "竞品周报")
check("读到 triggers", values.triggers === "竞品 周报")
check("深层 form_value", formFieldString(values.steps) === "先查官网再汇总")

const wrapped = {
  schema: "2.0",
  event: {
    action: {
      form_value: { skill_name: "嵌套", steps: "xxxxxxxxxx" },
    },
  },
}
const evt2 = { ...evt, raw: wrapped }
check("schema 2.0 包装", extractFormValues(evt2).skill_name === "嵌套")

const partial = {
  action: {
    form_value: { skill_name: "只改名称" },
  },
}
const evt3 = { ...evt, raw: partial }
check("部分字段", extractFormValues(evt3).skill_name === "只改名称")

if (failures) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log("\nAll form-value checks passed.")
