#!/usr/bin/env node
/**
 * Count rows in a workbook extract written by feishu-bridge.
 *
 *   node sheet.mjs headers <table.txt>
 *   node sheet.mjs count <table.txt> [--sheet 名称] --where "列::empty" --where "列::contains::文本"
 *
 * --where 之间是并且。比较：empty、not-empty、contains::文本、not-contains::文本、equals::文本。
 * 只接受桥接抽出的表格文本，并且路径必须在会话收件或文件缓存里。不打印单元格原文。
 */
import fs from "node:fs"
import path from "node:path"

const fail = (message) => {
  console.error(`ERROR ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const command = args[0]
const fileArg = args[1]
if (!command || !fileArg || (command !== "headers" && command !== "count")) {
  fail('用法：sheet.mjs headers <表格.txt> 或 sheet.mjs count <表格.txt> --where "列::empty"')
}

const resolved = path.resolve(fileArg)
const normalized = resolved.replace(/\\/g, "/").toLowerCase()
// 检出目录可能叫 feishu_bridge，也可能叫 Feishu-Bridge；只要求落在 bridge 的
// data/workspaces 或 data/file-cache 下，不锁死仓库本身的命名。
const allowed = /\/feishu[-_]bridge\/data\/(?:workspaces|file-cache)\//.test(normalized)
if (!allowed || !resolved.toLowerCase().endsWith(".txt")) fail("只能读取会话里抽出的表格 txt")

let text
try {
  text = fs.readFileSync(resolved, "utf8")
} catch {
  fail("表格文本不存在")
}
if (!text.startsWith("来源：") || !/^完整度：/m.test(text)) fail("这不是已抽出的表格")

const completeness = /^完整度：(.+)$/m.exec(text)?.[1] ?? ""
const sheets = parseSheets(text)
if (sheets.length === 0) fail("表格里没有工作表")

if (command === "headers") {
  for (const sheet of sheets) {
    console.log(`# ${sheet.name}`)
    console.log(`rows ${sheet.rows.length}`)
    console.log(sheet.headers.join("\t"))
  }
  process.exit(0)
}

if (completeness !== "完整") fail(`表格${completeness}，不能计算个数或占比`)

let sheetName = ""
const wheres = []
for (let i = 2; i < args.length; i += 1) {
  const token = args[i]
  if (token === "--sheet") {
    sheetName = args[i + 1] ?? ""
    i += 1
    continue
  }
  if (token === "--where") {
    wheres.push(parseWhere(args[i + 1] ?? ""))
    i += 1
    continue
  }
  fail(`无法识别参数 ${token}`)
}
if (wheres.length === 0) fail("count 至少要一个 --where")

const sheet = sheetName ? sheets.find((item) => item.name === sheetName) : sheets.length === 1 ? sheets[0] : undefined
if (!sheet) fail(`要指定 --sheet。可选：${sheets.map((item) => item.name).join("、")}`)

const indexes = wheres.map((where) => columnIndex(sheet.headers, where.column))

let matched = 0
for (const row of sheet.rows) {
  const ok = wheres.every((where, position) => matchCell(row[indexes[position]] ?? "", where))
  if (!ok) continue
  matched += 1
}
const rows = sheet.rows.length
const ratio = rows === 0 ? "0%" : `${((matched / rows) * 100).toFixed(2)}%`
console.log(`filters ${wheres.length}`)
console.log(`sheet ${sheet.name}`)
console.log(`rows ${rows}`)
console.log(`matched ${matched}`)
console.log(`ratio ${ratio}`)

function columnIndex(headers, column) {
  const exact = headers.indexOf(column)
  if (exact >= 0) return exact
  const wanted = normHeader(column)
  const hits = []
  headers.forEach((header, index) => {
    if (normHeader(header) === wanted) hits.push(index)
  })
  if (hits.length === 1) return hits[0]
  fail(`没有列「${column}」。可选：${headers.join("、")}`)
}

function normHeader(value) {
  return value.replace(/\s+/g, "").replace(/安装/g, "装").toLowerCase()
}

function parseSheets(source) {
  const found = []
  const chunks = source.split(/\n(?=# )/)
  for (const chunk of chunks) {
    const name = /^# (.+)$/m.exec(chunk)?.[1]
    if (!name) continue
    const table = chunk.split("\n").filter((line) => line.length > 0 && !line.startsWith("# ") && !line.startsWith("数据行数：") && !line.startsWith("列："))
    const headers = (table[0] ?? "").split("\t")
    const rows = table.slice(1).map((line) => line.split("\t"))
    found.push({ name, headers, rows })
  }
  return found
}

function parseWhere(raw) {
  const parts = raw.split("::")
  const column = (parts[0] ?? "").trim()
  const op = (parts[1] ?? "").trim()
  const expected = parts.slice(2).join("::")
  if (!column) fail("--where 缺少列名")
  if (!["empty", "not-empty", "contains", "not-contains", "equals"].includes(op)) fail(`不支持的比较 ${op}`)
  if ((op === "contains" || op === "not-contains" || op === "equals") && expected.length === 0) fail(`${op} 缺少比较文本`)
  return { column, op, expected }
}

function matchCell(value, where) {
  const cell = value.trim()
  if (where.op === "empty") return cell.length === 0
  if (where.op === "not-empty") return cell.length > 0
  if (where.op === "equals") return cell === where.expected
  if (where.op === "contains") return cell.includes(where.expected)
  return !cell.includes(where.expected)
}
