import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

const require = createRequire(import.meta.url)
const JSZip = require("jszip")

const SLIDE_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
const SLIDE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
const SKIP_HEADING = /^(目录|封面|谢谢|感谢|尾页|结束页)$/
const PLACEHOLDER_TEXT = /^(xxx|单击此处编辑.*|点击输入.*)$/i

/**
 * Rebuild a deck on the template's own slides.
 * Cover, table of contents and closing page are cloned and only their text is
 * replaced. Middle pages reuse the template's content backgrounds — usually one
 * or two designs — once for every page the body needs.
 */
export async function fillTemplate({ templatePath, outPath, markdown, title, pages }) {
  const parsed = markdown ? pagesFromMarkdown(markdown) : { title: title || "文档", sections: sectionsFromPages(pages ?? []) }
  const deckTitle = clean(parsed.title) || "文档"
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath))
  const slides = await readSlides(zip)
  const roles = classifySlides(slides)
  const backgrounds = contentBackgrounds(slides, roles)
  if (!roles.cover && backgrounds.length === 0) throw new Error("模板里没有可套用的封面或内容页")

  for (const name of Object.keys(zip.files)) {
    if (/^ppt\/slides\/(?:_rels\/)?slide\d+\.xml(?:\.rels)?$/i.test(name)) zip.remove(name)
  }

  const presentation = await zip.file("ppt/presentation.xml").async("string")
  const size = slideSize(presentation)
  const layoutFile = roles.content?.layoutFile
  const layoutXml = layoutFile && zip.file(layoutFile) ? await zip.file(layoutFile).async("string") : ""
  const box = contentBox(layoutXml, size)
  const contentPages = layoutPages(parsed.sections, box)
  const rels = await zip.file("ppt/_rels/presentation.xml.rels").async("string")
  const types = await zip.file("[Content_Types].xml").async("string")
  let nextRel = maxRel(rels) + 1
  const slideIds = []
  const relationships = []
  const overrides = []
  const titles = []
  let index = 1

  const push = (xml, rel, label) => {
    zip.file(`ppt/slides/slide${index}.xml`, acceptSlide(xml, size))
    zip.file(`ppt/slides/_rels/slide${index}.xml.rels`, relsForSlide(rel, xml, zip))
    slideIds.push(`<p:sldId id="${256 + index}" r:id="rId${nextRel}"/>`)
    relationships.push(
      `<Relationship Id="rId${nextRel}" Type="${SLIDE_REL}" Target="slides/slide${index}.xml"/>`,
    )
    overrides.push(
      `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="${SLIDE_TYPE}"/>`,
    )
    titles.push(clean(label).slice(0, 40) || "幻灯片")
    nextRel += 1
    index += 1
  }

  if (roles.cover) push(fillCover(roles.cover.xml, deckTitle), roles.cover.rels, deckTitle)
  if (roles.toc) {
    const labels = []
    for (const section of parsed.sections) {
      const heading = clean(section.heading)
      if (heading && !SKIP_HEADING.test(heading) && !labels.includes(heading)) labels.push(heading)
    }
    push(fillToc(roles.toc.xml, labels), roles.toc.rels, "目录")
  }
  contentPages.forEach((page, pageIndex) => {
    const background = backgrounds[pageIndex % backgrounds.length]
    push(fillContent(background.xml, page, box, size), background.rels, page.title)
  })
  if (roles.ending) push(fillEnding(roles.ending.xml), roles.ending.rels, "谢谢")

  zip.file(
    "ppt/presentation.xml",
    presentation.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${slideIds.join("")}</p:sldIdLst>`),
  )
  const strippedRels = rels.replace(new RegExp(`<Relationship\\b[^>]*Type="${SLIDE_REL}"[^>]*/>`, "g"), "")
  zip.file("ppt/_rels/presentation.xml.rels", strippedRels.replace("</Relationships>", `${relationships.join("")}</Relationships>`))
  const strippedTypes = types
    .replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*\/>/g, "")
    .replace(/<Override PartName="\/ppt\/notesSlides\/[^"]+"[^>]*\/>/g, "")
  zip.file("[Content_Types].xml", strippedTypes.replace("</Types>", `${overrides.join("")}</Types>`))
  const app = zip.file("docProps/app.xml")
  if (app) zip.file("docProps/app.xml", fixApp(await app.async("string"), titles))
  await dropUnreferenced(zip)
  const problems = await packageProblems(zip, titles.length)
  if (problems.length > 0) throw new Error(`未写出文件，PowerPoint 不会接受：${problems.join("；")}`)

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
  fs.writeFileSync(outPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))
  return {
    slides: index - 1,
    cover: Boolean(roles.cover),
    toc: Boolean(roles.toc),
    ending: Boolean(roles.ending),
    contentLayout: backgrounds.map((item) => item.layoutFile).filter(Boolean).join(",") ,
  }
}

export function pagesFromMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n")
  let title = ""
  const sections = []
  let current
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const text = cleanInline(heading[2] ?? "")
      if ((heading[1]?.length ?? 0) === 1 && !title) {
        title = text
        continue
      }
      if (current) sections.push(current)
      current = { heading: text, lines: [] }
      continue
    }
    if (!current) {
      if (!line.trim()) continue
      if (!title) title = cleanInline(line)
      else current = { heading: title, lines: [line] }
      continue
    }
    current.lines.push(line)
  }
  if (current) sections.push(current)
  const resolved = []
  for (const section of sections) {
    if (SKIP_HEADING.test(section.heading)) continue
    const { pieces, tables, charts } = splitBody(section.lines.join("\n"))
    resolved.push({ heading: section.heading || "正文", pieces, tables, charts })
  }
  if (resolved.length === 0) {
    resolved.push({ heading: title || "正文", pieces: [{ role: "body", text: clean(markdown) || "未提供" }], tables: [], charts: [] })
  }
  return { title: title || resolved[0].heading, sections: resolved }
}

/** External callers may hand over ready-made pages instead of markdown. */
function sectionsFromPages(pages) {
  const sections = (pages ?? []).map((page) => ({
    heading: clean(page.title) || "正文",
    pieces: Array.isArray(page.pieces) ? page.pieces : [],
    tables: Array.isArray(page.table) ? [page.table] : [],
    charts: page.chart && Array.isArray(page.chart.rows) ? [page.chart] : [],
  }))
  return sections.length > 0 ? sections : [{ heading: "正文", pieces: [{ role: "body", text: "未提供" }], tables: [], charts: [] }]
}

/**
 * Lay sections out onto pages. Text is packed by estimated rendered height so
 * a page is filled evenly instead of a fixed six pieces — this is what keeps
 * text from spilling past the slide and avoids half-empty pages.
 */
function layoutPages(sections, box) {
  const pages = []
  let lastChart = ""
  for (const section of sections) {
    const heading = clean(section.heading) || "正文"
    let used = false
    const titleFor = () => {
      const pageTitle = used ? `${heading}（续）` : heading
      used = true
      return pageTitle
    }
    const hasContent = section.pieces.length > 0 || section.tables.length > 0 || section.charts.length > 0
    if (!hasContent) {
      pages.push({ title: titleFor(), pieces: [{ role: "body", text: "未提供" }], table: null, chart: null, scale: 1 })
      continue
    }
    for (const group of packPieces(section.pieces, box)) {
      pages.push({ title: titleFor(), pieces: group.pieces, table: null, chart: null, scale: group.scale })
    }
    for (const table of section.tables) {
      const visual = visualizeTable(table, lastChart)
      if (visual) {
        lastChart = visual.type
        pages.push({ title: titleFor(), pieces: [], table: null, chart: visual, scale: 1 })
        continue
      }
      for (const part of packTableRows(table, box)) {
        pages.push({ title: titleFor(), pieces: [], table: part.rows, rowHeights: part.heights, chart: null, scale: 1 })
      }
    }
    for (const chart of section.charts) {
      lastChart = chart.type
      pages.push({ title: titleFor(), pieces: [], table: null, chart, scale: 1 })
    }
  }
  if (pages.length === 0) pages.push({ title: "正文", pieces: [{ role: "body", text: "未提供" }], table: null, chart: null, scale: 1 })
  return pages.slice(0, 48)
}

/** Estimated width of a string in thousandths of the font size. */
function textUnits(text) {
  let units = 0
  for (const ch of String(text ?? "")) units += ch.codePointAt(0) > 0x2e7f ? 1000 : 560
  return units
}

function estimatePieceHeight(piece, cx) {
  const fontPt = piece.role === "subtitle" ? 19 : 15
  const size = fontPt * 12700
  const lineWidth = Math.max(cx - 260000, 1200000)
  const textW = (textUnits(piece.text) / 1000) * size
  const lines = Math.max(Math.ceil(textW / lineWidth), 1)
  const lineH = size * 1.16
  const before = (piece.role === "subtitle" ? 560 : 260) * 127
  return lines * lineH + before
}

function packPieces(pieces, box) {
  const list = pieces.length > 0 ? pieces : [{ role: "body", text: "未提供" }]
  const budget = Math.round(box.cy * 0.96)
  const groups = []
  let current = []
  let used = 0
  for (const piece of list) {
    const h = estimatePieceHeight(piece, box.cx)
    if (current.length > 0 && used + h > budget) {
      groups.push(current)
      current = []
      used = 0
    }
    current.push(piece)
    used += h
  }
  if (current.length > 0) groups.push(current)
  return groups.map((group) => {
    const total = group.reduce((sum, piece) => sum + estimatePieceHeight(piece, box.cx), 0)
    const scale = total > budget ? Math.max(Math.round((budget / total) * 100) / 100, 0.72) : 1
    return { pieces: group, scale }
  })
}

function estimateRowHeight(row, columns, header) {
  const size = 12 * 12700
  let lines = 1
  row.forEach((cellText, index) => {
    const width = Math.max((columns[index] ?? columns[0] ?? 2000000) - 140000, 300000)
    const textW = (textUnits(cellText) / 1000) * size
    lines = Math.max(lines, Math.ceil(textW / width))
  })
  return Math.max(Math.round(lines * size * 1.2) + 120000, header ? 380000 : 300000)
}

function packTableRows(table, box) {
  const width = Math.max(...table.map((row) => row.length), 1)
  const columns = splitExtent(box.cx, width)
  const header = table[0]
  const headerH = estimateRowHeight(header, columns, true)
  const budget = Math.round(box.cy * 0.98)
  const parts = []
  let rows = []
  let heights = []
  let used = headerH
  for (const row of table.slice(1)) {
    const h = estimateRowHeight(row, columns, false)
    if (rows.length > 0 && used + h > budget) {
      parts.push({ rows: [header, ...rows], heights: [headerH, ...heights] })
      rows = []
      heights = []
      used = headerH
    }
    rows.push(row)
    heights.push(h)
    used += h
  }
  parts.push({ rows: [header, ...rows], heights: [headerH, ...heights] })
  return parts
}

function splitBody(body) {
  const charts = []
  const source = String(body).replace(/```chart[^\n]*\n([\s\S]*?)```/gi, (_full, inner) => {
    const chart = chartFromFence(inner)
    if (chart) charts.push(chart)
    return ""
  })
  const pieces = []
  const tables = []
  let current
  const flush = () => {
    if (current && current.length > 0) tables.push(current)
    current = undefined
  }
  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (!line || line === "---") {
      flush()
      continue
    }
    if (line.startsWith("|")) {
      const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cleanInline(cell))
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
      if (!current) current = []
      current.push(cells)
      continue
    }
    flush()
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line)
    if (bullet) {
      const text = cleanInline(bullet[1] ?? "")
      if (text) pieces.push({ role: "bullet", text })
      continue
    }
    const text = cleanInline(line)
    if (!text) continue
    const subtitle = pieces.every((piece) => piece.role !== "subtitle") && text.length <= 28 && !/[。！？]$/.test(text)
    pieces.push({ role: subtitle ? "subtitle" : "body", text })
  }
  flush()
  return { pieces, tables, charts }
}

function chartFromFence(inner) {
  const lines = String(inner).replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return null
  let type = "bar"
  let start = 0
  const head = lines[0].toLowerCase()
  if (/^(pie|bar|column|饼图|条形图|柱状图)$/.test(head)) {
    type = head === "pie" || head === "饼图" ? "pie" : head === "column" || head === "柱状图" ? "column" : "bar"
    start = 1
  }
  const rows = []
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) continue
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cleanInline(cell))
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
    rows.push(cells)
  }
  return rows.length > 1 ? { type, rows } : null
}

/** A two-column numeric table becomes a chart. Wider tables stay tables. */
function visualizeTable(table, lastType) {
  if (!Array.isArray(table) || table.length < 3) return null
  const width = Math.max(...table.map((row) => row.length))
  if (width !== 2) return null
  const body = table.slice(1).filter((row) => row.some((cell) => clean(cell)))
  if (body.length < 2 || !body.every((row) => measureOf(row[1]) !== null && clean(row[0]).length > 0 && clean(row[0]).length <= 28)) return null
  const series = chartSeries(table)
  if (series.length < 2) return null
  const header = table[0].join(" ")
  const labels = series.map((item) => item.label).join(" ")
  const total = series.reduce((sum, item) => sum + item.value, 0)
  const share = /占比|比例|构成|分布|份额|%/.test(header) || (series.every((item) => item.value <= 100) && Math.abs(total - 100) <= 5)
  let type = "bar"
  if (share) type = "pie"
  else if (/年|月|趋势|增长/.test(`${header} ${labels}`)) type = "column"
  if (type !== "pie" && type === lastType) type = type === "column" ? "bar" : "column"
  return { type, rows: table }
}

async function readSlides(zip) {
  const slides = []
  for (const name of Object.keys(zip.files)) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name)
    if (!match) continue
    const index = Number(match[1])
    const xml = await zip.file(name).async("string")
    const relName = `ppt/slides/_rels/slide${index}.xml.rels`
    const rels = zip.file(relName) ? await zip.file(relName).async("string") : ""
    const layoutTarget = rels.match(/Target="([^"]*slideLayout\d+\.xml)"/)?.[1] ?? ""
    const layoutFile = layoutTarget ? path.posix.normalize(`ppt/slides/${layoutTarget}`).replace(/^ppt\/slides\/\.\.\//, "ppt/") : ""
    slides.push({ index, xml, rels, layoutFile, text: slideText(xml) })
  }
  return slides.sort((a, b) => a.index - b.index)
}

function classifySlides(slides) {
  const cover = slides.find((slide) => /模版|模板/.test(slide.text)) ?? slides[0]
  const toc = slides.find((slide) => slide !== cover && /目录/.test(slide.text))
  const content = slides.find((slide) => slide !== cover && slide !== toc && clean(slide.text).length === 0)
  let ending = [...slides].reverse().find((slide) => slide !== cover && slide !== toc && slide !== content && PLACEHOLDER_TEXT.test(plain(slide.text)))
  if (!ending) {
    ending = [...slides].reverse().find((slide) => slide !== cover && slide !== toc && slide !== content && /^(谢谢|感谢)/.test(plain(slide.text)))
  }
  return { cover, toc, content, ending }
}

/**
 * Middle slides are background designs, not a page budget. A blank content
 * slide is used as drawn. A finished sample contributes at most two shells,
 * and those shells are repeated for every body page.
 */
function contentBackgrounds(slides, roles) {
  const middle = slides.filter((slide) => slide !== roles.cover && slide !== roles.toc && slide !== roles.ending)
  const blank = middle.filter((slide) => clean(slide.text).length === 0)
  if (blank.length > 0) return blank.slice(0, 2).map((slide) => ({ xml: slide.xml, rels: slide.rels, layoutFile: slide.layoutFile }))
  const groups = new Map()
  for (const slide of middle) {
    const key = mediaKey(slide.rels)
    const list = groups.get(key) ?? []
    list.push(slide)
    groups.set(key, list)
  }
  const picks = [...groups.values()]
    .sort((a, b) => shortestText(a) - shortestText(b))
    .slice(0, 2)
  if (picks.length === 0 && roles.cover) {
    return [{ xml: shellXml(roles.cover.xml), rels: roles.cover.rels, layoutFile: roles.cover.layoutFile }]
  }
  return picks.map((list) => {
    const slide = [...list].sort((a, b) => clean(a.text).length - clean(b.text).length)[0]
    return { xml: shellXml(slide.xml), rels: slide.rels, layoutFile: slide.layoutFile }
  })
}

function shortestText(slides) {
  return Math.min(...slides.map((slide) => clean(slide.text).length))
}

function mediaKey(rels) {
  const images = [...rels.matchAll(/Target="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((target) => /media\/image\d+/i.test(target))
    .sort()
  return images.join("|") || "plain"
}

/** Keep the background pictures. Drop the sample deck's words and charts. */
function shellXml(xml) {
  return xml
    .replace(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g, "")
    .replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (shape) => (/<a:t[\s>]/.test(shape) ? "" : shape))
}

function plain(value) {
  return clean(value).replace(/\s+/g, "")
}

function fillCover(xml, title) {
  let done = false
  return xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) => {
    const text = slideText(shape)
    if (!done && (/模版|模板/.test(text) || /name="[^"]*标题/.test(shape))) {
      done = true
      return replaceFirstRun(shape, title)
    }
    return shape.replace(/<a:t([^>]*)>XXX<\/a:t>/g, "<a:t$1></a:t>")
  })
}

function fillToc(xml, labels) {
  const rebuilt = rebuildToc(xml, labels)
  if (rebuilt) return rebuilt
  if (!/>XXX</.test(xml)) return fillNumberedToc(xml, labels)
  let slot = 0
  return xml.replace(/<a:t([^>]*)>XXX<\/a:t>/g, (full, attrs) => {
    const label = labels[slot] ?? ""
    slot += 1
    return `<a:t${attrs}>${escapeXml(label)}</a:t>`
  })
}

/**
 * Rebuild the contents page so its entries match the real section count.
 * The template only fixes the look — rows (number badge + label + ornaments)
 * are cloned or removed as needed and spread evenly over the original area.
 * Returns null when the page structure is not recognized, and the caller
 * falls back to plain slot filling.
 */
function rebuildToc(xml, labels) {
  const count = labels.length
  if (count === 0) return null
  const treeOpen = /<p:spTree(?=[\s>])/.exec(xml)
  if (!treeOpen) return null
  const treeStart = xml.indexOf(">", treeOpen.index) + 1
  const treeEnd = xml.lastIndexOf("</p:spTree>")
  if (treeEnd <= treeStart) return null
  const root = scanTocNodes(xml, treeStart, treeEnd)
  const labelBox = findLabelContainer(root)
  if (!labelBox) return null
  const isLabel = labelBox.mode === "xxx"
    ? (child) => child.tag === "sp" && />XXX</.test(child.xml)
    : (child) => child.tag === "sp" && isTocTextLabel(nodeText(child))
  const slotCount = labelBox.node.children.filter(isLabel).length
  if (slotCount === 0 || slotCount === count) return null
  const numberBox = findNumberContainer(root, labelBox.node)
  const labelRows = clusterTocRows(labelBox.node, isLabel, numberBox)
  if (!labelRows) return null
  const labelRendered = renderTocRows(labelRows, count, (member, index) => {
    if (isLabel(member)) return { label: labels[index] }
    if (/^\d{2}$/.test(nodeText(member).trim())) return { number: index + 1 }
    return {}
  })
  let numberRendered = null
  let numberRows = null
  if (numberBox) {
    numberRows = clusterTocRows(numberBox, (child) => /^\d{2}$/.test(nodeText(child).trim()), null)
    if (!numberRows) return null
    numberRendered = renderTocRows(numberRows, count, (member, index) =>
      /^\d{2}$/.test(nodeText(member).trim()) ? { number: index + 1 } : {},
    )
  }
  // Replace the later span first so earlier offsets stay valid. The replaced
  // span is what matters, not where the container tag opens.
  const jobs = [
    { rows: labelRows, rendered: labelRendered, box: labelBox.node },
    numberBox ? { rows: numberRows, rendered: numberRendered, box: numberBox } : null,
  ]
    .filter(Boolean)
    .sort((a, b) => b.rows[0].members[0].start - a.rows[0].members[0].start)
  let next = xml
  for (const job of jobs) next = replaceTocRows(next, job.box, job.rows, job.rendered)
  return next
}

function scanTocNodes(xml, from, to) {
  const children = []
  const re = /<p:(sp|grpSp|pic|graphicFrame|cxnSp)(?=[\s>])/g
  re.lastIndex = from
  let match
  while ((match = re.exec(xml))) {
    if (match.index >= to) break
    const tag = match[1]
    const openRe = new RegExp(`<p:${tag}(?=[\\s>])`, "g")
    const closeRe = new RegExp(`</p:${tag}>`, "g")
    let depth = 0
    let cursor = match.index
    let end = -1
    while (cursor < to) {
      openRe.lastIndex = cursor
      closeRe.lastIndex = cursor
      const open = openRe.exec(xml)
      const close = closeRe.exec(xml)
      if (!close || close.index >= to) break
      if (open && open.index < close.index) {
        depth += 1
        cursor = open.index + 1
      } else {
        depth -= 1
        cursor = close.index + 1
        if (depth === 0) {
          end = close.index + close[0].length
          break
        }
      }
    }
    if (end < 0) break
    const node = { tag, start: match.index, end, xml: xml.slice(match.index, end), children: [] }
    if (tag === "grpSp") {
      const innerStart = xml.indexOf("</p:grpSpPr>", node.start)
      if (innerStart < 0 || innerStart >= end) continue
      node.innerStart = innerStart + "</p:grpSpPr>".length
      node.innerEnd = end - "</p:grpSp>".length
      node.children = scanTocNodes(xml, node.innerStart, node.innerEnd).children
    }
    children.push(node)
    re.lastIndex = end
  }
  return { children, innerStart: from, innerEnd: to }
}

function nodeText(node) {
  return [...node.xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join("")
}

function nodeY(node) {
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(node.xml)
  return off ? Number(off[2]) : null
}

function nodeCy(node) {
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(node.xml)
  return ext ? Number(ext[2]) : 0
}

function isTocTextLabel(text) {
  const value = text.trim()
  return value.length > 0 && !/^\d{2}$/.test(value) && value !== "→" && !/^(目录|contents)$/i.test(value)
}

function findLabelContainer(root) {
  let best = null
  const visitXxx = (node) => {
    const count = node.children.filter((child) => child.tag === "sp" && />XXX</.test(child.xml)).length
    if (count > (best?.count ?? 0)) best = { node, count, mode: "xxx" }
    for (const child of node.children) if (child.tag === "grpSp") visitXxx(child)
  }
  visitXxx(root)
  if (best) return best
  const visitNumbered = (node) => {
    const numbers = node.children.filter((child) => /^\d{2}$/.test(nodeText(child).trim())).length
    const texts = node.children.filter((child) => child.tag === "sp" && isTocTextLabel(nodeText(child))).length
    if (numbers >= 2 && texts >= 2 && texts > (best?.count ?? 0)) best = { node, count: texts, mode: "numbered" }
    for (const child of node.children) if (child.tag === "grpSp") visitNumbered(child)
  }
  visitNumbered(root)
  return best
}

function findNumberContainer(root, exclude) {
  let best = null
  const visit = (node) => {
    if (node !== exclude) {
      const count = node.children.filter((child) => /^\d{2}$/.test(nodeText(child).trim())).length
      if (count >= 2 && count > (best?.count ?? 0)) best = node
    }
    for (const child of node.children) if (child.tag === "grpSp") visit(child)
  }
  visit(root)
  return best
}

/** Group a container's children into entry rows around anchor shapes. */
function clusterTocRows(container, isAnchor, exclude) {
  const anchors = container.children.filter(isAnchor).sort((a, b) => nodeY(a) - nodeY(b))
  if (anchors.length === 0 || anchors.some((node) => nodeY(node) === null)) return null
  const rows = anchors.map((anchor) => ({ anchor, members: [anchor] }))
  const spacing = anchors.length > 1 ? Math.abs(nodeY(anchors[1]) - nodeY(anchors[0])) : 900000
  for (const child of container.children) {
    if (isAnchor(child) || child === exclude || child.tag === "pic") continue
    if (nodeY(child) === null) continue
    const center = nodeY(child) + nodeCy(child) / 2
    let best = null
    let bestDist = Infinity
    for (const row of rows) {
      const anchorCenter = nodeY(row.anchor) + nodeCy(row.anchor) / 2
      const dist = Math.abs(center - anchorCenter)
      if (dist < bestDist) {
        bestDist = dist
        best = row
      }
    }
    if (best && bestDist <= Math.max(spacing * 0.6, 300000)) best.members.push(child)
  }
  for (const row of rows) row.members.sort((a, b) => a.start - b.start)
  return rows
}

/** Clone entry rows so there are `count` of them, spread over the original area. */
function renderTocRows(rows, count, textFor) {
  const top = Math.min(...rows.flatMap((row) => row.members.map((member) => nodeY(member))))
  const bottom = Math.max(...rows.flatMap((row) => row.members.map((member) => nodeY(member) + nodeCy(member))))
  if (bottom <= top) return ""
  const slotH = (bottom - top) / count
  const protoH = (bottom - top) / rows.length
  const ratio = slotH / protoH
  const parts = []
  for (let index = 0; index < count; index += 1) {
    const proto = rows[index % rows.length]
    const protoTop = Math.min(...proto.members.map((member) => nodeY(member)))
    for (const member of proto.members) {
      const newY = Math.round(top + index * slotH + (nodeY(member) - protoTop) * ratio)
      let out = member.xml.replace(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/, (_full, x) => `<a:off x="${x}" y="${newY}"/>`)
      const action = textFor(member, index)
      if (action.label !== undefined) out = setFirstText(out, action.label.slice(0, 24))
      else if (action.number !== undefined) out = setNumberText(out, action.number)
      parts.push(out)
    }
  }
  return parts.join("")
}

function replaceTocRows(xml, container, rows, rendered) {
  const spans = rows
    .flatMap((row) => row.members)
    .map((member) => [member.start, member.end])
    .sort((a, b) => a[0] - b[0])
  let out = xml.slice(0, container.innerStart)
  let cursor = container.innerStart
  let inserted = false
  for (const [start, end] of spans) {
    out += xml.slice(cursor, start)
    if (!inserted) {
      out += rendered
      inserted = true
    }
    cursor = end
  }
  return out + xml.slice(cursor)
}

function setFirstText(spXml, text) {
  let used = false
  return spXml.replace(/<a:t([^>]*)>([^<]*)<\/a:t>/g, (full, attrs) => {
    if (used) return `<a:t${attrs}></a:t>`
    used = true
    return `<a:t${attrs}>${escapeXml(text)}</a:t>`
  })
}

function setNumberText(nodeXml, value) {
  let used = false
  const label = String(value).padStart(2, "0")
  return nodeXml.replace(/<a:t([^>]*)>([^<]*)<\/a:t>/g, (full, attrs, text) => {
    if (used || !/^\d{2}$/.test(decodeXml(text).trim())) return full
    used = true
    return `<a:t${attrs}>${label}</a:t>`
  })
}

/** A finished sample deck numbers its contents as 01, 02, … instead of XXX. */
function fillNumberedToc(xml, labels) {
  let slot = 0
  let expectLabel = false
  return xml.replace(/<a:t([^>]*)>([^<]*)<\/a:t>/g, (full, attrs, text) => {
    const value = decodeXml(text).trim()
    if (/^\d{2}$/.test(value)) {
      expectLabel = true
      return full
    }
    if (!expectLabel || !value || value === "→") return full
    expectLabel = false
    const label = labels[slot] ?? ""
    slot += 1
    if (!label) return `<a:t${attrs}></a:t>`
    return `<a:t${attrs}>${escapeXml(label.slice(0, 16))}</a:t>`
  })
}

function fillEnding(xml) {
  return xml.replace(/<a:t([^>]*)>([^<]*)<\/a:t>/g, (full, attrs, text) => {
    if (!PLACEHOLDER_TEXT.test(decodeXml(text).trim())) return full
    return `<a:t${attrs}>谢谢</a:t>`
  })
}

function fillContent(xml, page, box, size) {
  const opened = openGroup(xml, size)
  const ids = { n: 2 }
  const title = titleShape(page.title, ids)
  const body = page.chart
    ? chartShapes(page.chart, box, ids)
    : page.table
      ? tableShape(page.table, box, ids, page.rowHeights)
      : textShape(page.pieces, box, ids, page.scale ?? 1)
  if (opened.includes("</p:spTree>")) return opened.replace("</p:spTree>", `${title}${body}</p:spTree>`)
  return opened
}

function openGroup(xml, size) {
  return xml.replace(/<p:grpSp\b[\s\S]*?<\/p:grpSp>/g, (group) => expandGroup(group, size))
}

/**
 * PowerPoint requires the root shape tree to stay at zero size. Rewriting that
 * root to the slide size is what makes it offer to repair the file. Only a
 * nested group that already contains shapes may be given a real size.
 */
/** The root shape-tree transform. Nested groups are ignored on purpose. */
function rootXfrm(xml) {
  const tree = xml.indexOf("<p:spTree")
  if (tree < 0) return null
  const nvEnd = xml.indexOf("</p:nvGrpSpPr>", tree)
  if (nvEnd < 0) return null
  const group = xml.indexOf("<p:grpSpPr", nvEnd)
  if (group < 0 || group - nvEnd > 40) return null
  const start = xml.indexOf("<a:xfrm", group)
  const end = xml.indexOf("</a:xfrm>", start)
  if (start < 0 || end < 0 || start - group > 80) return null
  return { start, end: end + "</a:xfrm>".length, body: xml.slice(start, end) }
}

function restoreRootGroup(xml) {
  const span = rootXfrm(xml)
  if (!span) return xml
  const zero = `<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>`
  return xml.slice(0, span.start) + zero + xml.slice(span.end)
}

function expandGroup(group, size) {
  const hasChild = /<p:sp\b|<p:pic\b|<p:graphicFrame\b/.test(group)
  const zero = /<a:ext\s+cx="0"\s+cy="0"\s*\/>/.test(group) || /<a:chExt\s+cx="0"\s+cy="0"\s*\/>/.test(group)
  if (!hasChild || !zero) return group
  return group
    .replace(/<a:ext\s+cx="0"\s+cy="0"\s*\/>/g, `<a:ext cx="${size.cx}" cy="${size.cy}"/>`)
    .replace(/<a:chExt\s+cx="0"\s+cy="0"\s*\/>/g, `<a:chExt cx="${size.cx}" cy="${size.cy}"/>`)
}

/** Rewrite a slide until it satisfies the constraints PowerPoint repairs on open. */
function acceptSlide(xml, size) {
  let next = xml.replace(/\brot="(-?\d+)"/g, (full, value) => {
    const angle = Number(value)
    if (angle >= 0 && angle <= 21_600_000) return full
    return `rot="${fixedAngle(angle / 60_000)}"`
  })
  next = next.replace(
    /<a:prstGeom prst="pie"><a:avLst><a:gd name="adj" fmla="val (\d+)"\/><\/a:avLst>/g,
    (_, adj) =>
      `<a:prstGeom prst="pie"><a:avLst><a:gd name="adj1" fmla="val ${Math.min(Math.max(Number(adj), 1), 21_599_999)}"/><a:gd name="adj2" fmla="val 0"/></a:avLst>`,
  )
  next = next.replace(/prst="pie">([\s\S]*?)<\/a:avLst>/g, (block) =>
    block.replace(/fmla="val (\d+)"/g, (full, value) => {
      const angle = Number(value)
      if (angle >= 0 && angle <= 21_599_999) return full
      return `fmla="val ${Math.min(Math.max(angle, 0), 21_599_999)}"`
    }),
  )
  next = expandFilledGroups(next, size)
  next = restoreRootGroup(next)
  next = uniqueShapeIds(next)
  next = fitTables(next)
  const problems = slideProblems(next)
  if (problems.length > 0) throw new Error(problems.join("；"))
  return next
}

function expandFilledGroups(xml, size) {
  return xml.replace(/<p:grpSp\b[\s\S]*?<\/p:grpSp>/g, (group) => expandGroup(group, size))
}

function uniqueShapeIds(xml) {
  const used = new Set()
  let next = 1
  return xml.replace(/<p:cNvPr id="(\d+)"/g, (full, id) => {
    if (!used.has(id)) {
      used.add(id)
      next = Math.max(next, Number(id) + 1)
      return full
    }
    while (used.has(String(next))) next += 1
    const fresh = String(next)
    used.add(fresh)
    next += 1
    return `<p:cNvPr id="${fresh}"`
  })
}

/** Keep each row and column's own size; only the last one absorbs any drift. */
function fitTables(xml) {
  return xml.replace(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g, (frame) => {
    const ext = frame.match(/<p:xfrm>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/)
    if (!ext) return frame
    const cols = [...frame.matchAll(/<a:gridCol w="(\d+)"\/>/g)]
    const rows = [...frame.matchAll(/<a:tr h="(\d+)"/g)]
    if (cols.length === 0 || rows.length === 0) return frame
    const colDrift = Number(ext[1]) - cols.reduce((sum, match) => sum + Number(match[1]), 0)
    const rowDrift = Number(ext[2]) - rows.reduce((sum, match) => sum + Number(match[1]), 0)
    let colIndex = 0
    let rowIndex = 0
    return frame
      .replace(/<a:gridCol w="(\d+)"\/>/g, (_full, w) => `<a:gridCol w="${Number(w) + (colIndex++ === cols.length - 1 ? colDrift : 0)}"/>`)
      .replace(/<a:tr h="(\d+)"/g, (_full, h) => `<a:tr h="${Number(h) + (rowIndex++ === rows.length - 1 ? rowDrift : 0)}"`)
  })
}

function slideProblems(xml) {
  const problems = []
  for (const value of xml.matchAll(/\brot="(-?\d+)"/g)) {
    const angle = Number(value[1])
    if (angle < 0 || angle > 21_600_000) problems.push(`旋转角 ${angle} 超出 0–360 度`)
  }
  if (/prst="pie"[\s\S]{0,160}name="adj"(?!\d)/.test(xml)) problems.push("饼图使用了 PowerPoint 不认识的角度参数")
  for (const guide of xml.matchAll(/prst="pie"[\s\S]{0,240}?<\/a:avLst>/g)) {
    for (const value of guide[0].matchAll(/fmla="val (\d+)"/g)) {
      const angle = Number(value[1])
      if (angle < 0 || angle > 21_599_999) problems.push(`饼图角度 ${angle} 超出 PowerPoint 允许范围`)
    }
  }
  const root = rootXfrm(xml)
  if (root) {
    const sizes = [...root.body.matchAll(/\b(?:cx|cy)="(-?\d+)"/g)].map((match) => match[1])
    if (sizes.length < 4 || sizes.some((value) => value !== "0")) problems.push("幻灯片根组合被写成了非 0 尺寸")
  }
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml)) problems.push("存在未转义的 &")
  const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => match[1])
  if (new Set(ids).size !== ids.length) problems.push("形状编号重复")
  for (const frame of xml.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)) {
    const ext = frame[0].match(/<p:xfrm>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/)
    if (!ext) continue
    const cols = [...frame[0].matchAll(/<a:gridCol w="(\d+)"\/>/g)].reduce((sum, match) => sum + Number(match[1]), 0)
    const rows = [...frame[0].matchAll(/<a:tr h="(\d+)"/g)].reduce((sum, match) => sum + Number(match[1]), 0)
    if (cols !== Number(ext[1]) || rows !== Number(ext[2])) problems.push("表格宽高与单元格之和不一致")
  }
  for (const group of xml.matchAll(/<p:grpSp\b[\s\S]*?<\/p:grpSp>/g)) {
    const hasChild = /<p:sp\b|<p:pic\b|<p:graphicFrame\b/.test(group[0])
    const zero = /<a:ext\s+cx="0"\s+cy="0"\s*\/>/.test(group[0]) || /<a:chExt\s+cx="0"\s+cy="0"\s*\/>/.test(group[0])
    if (hasChild && zero) problems.push("组合框尺寸为 0 但里面有形状")
  }
  return problems
}

function relsForSlide(relXml, slideXml, zip) {
  let rels = keepExistingRels(relXml, zip)
  if (!/<c:chart\b|chart\d+\.xml/.test(slideXml)) {
    rels = rels.replace(/<Relationship\b[^>]*Type="[^"]*\/chart"[^>]*\/>/g, "")
  }
  return rels
}

async function dropUnreferenced(zip) {
  const referenced = await referencedParts(zip)
  for (const name of Object.keys(zip.files)) {
    if (name.endsWith("/") || referenced.has(name)) continue
    if (/^ppt\/(?:charts|embeddings|media|notesSlides|notesMasters|diagrams)\//.test(name)) zip.remove(name)
  }
  const types = zip.file("[Content_Types].xml")
  if (!types) return
  const xml = await types.async("string")
  zip.file(
    "[Content_Types].xml",
    xml.replace(/<Override\b[^>]*PartName="([^"]+)"[^>]*\/>/g, (tag, part) => (zip.file(part.replace(/^\//, "")) ? tag : "")),
  )
}

async function referencedParts(zip) {
  const keep = new Set(["[Content_Types].xml", "ppt/presentation.xml", "_rels/.rels"])
  const queue = ["ppt/_rels/presentation.xml.rels", "_rels/.rels"]
  const seen = new Set()
  while (queue.length > 0) {
    const relPath = queue.pop()
    if (!relPath || seen.has(relPath) || !zip.file(relPath)) continue
    seen.add(relPath)
    keep.add(relPath)
    const xml = await zip.file(relPath).async("string")
    for (const match of xml.matchAll(/Target="([^"]+)"/g)) {
      const target = match[1]
      if (!target || /^[a-z]+:/i.test(target)) continue
      const full = resolveTarget(relPath, target)
      keep.add(full)
      const slash = full.lastIndexOf("/")
      const rels = slash < 0 ? `_rels/${full}.rels` : `${full.slice(0, slash)}/_rels/${full.slice(slash + 1)}.rels`
      if (zip.file(rels)) queue.push(rels)
    }
  }
  return keep
}

function resolveTarget(relPath, target) {
  const dir = relPath.slice(0, relPath.lastIndexOf("/")).replace(/\/_rels$/, "")
  const parts = `${dir}/${target}`.split("/")
  const out = []
  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

function keepExistingRels(relXml, zip) {
  return relXml.replace(/<Relationship\b[^>]*\/>/g, (rel) => {
    const target = rel.match(/Target="([^"]+)"/)?.[1]
    if (!target || /^[a-z]+:/i.test(target)) return rel
    const full = target.startsWith("../") ? `ppt/${target.slice(3)}` : `ppt/slides/${target}`
    return zip.file(full) ? rel : ""
  })
}

async function packageProblems(zip, slideCount) {
  const problems = []
  const presentation = await zip.file("ppt/presentation.xml").async("string")
  const ids = [...presentation.matchAll(/<p:sldId\b[^>]*id="(\d+)"/g)].map((match) => Number(match[1]))
  if (ids.length !== slideCount) problems.push(`幻灯片清单 ${ids.length} 页，实际 ${slideCount} 页`)
  if (new Set(ids).size !== ids.length) problems.push("幻灯片编号重复")
  if (ids.some((id) => id < 256 || id > 2_147_483_646)) problems.push("幻灯片编号超出 PowerPoint 范围")
  const types = await zip.file("[Content_Types].xml").async("string")
  for (let index = 1; index <= slideCount; index += 1) {
    const part = `ppt/slides/slide${index}.xml`
    if (!zip.file(part)) problems.push(`缺少 ${part}`)
    if (!types.includes(`/ppt/slides/slide${index}.xml`)) problems.push(`内容类型缺少第 ${index} 页`)
    const xml = zip.file(part) ? await zip.file(part).async("string") : ""
    problems.push(...slideProblems(xml).map((item) => `第 ${index} 页${item}`))
  }
  for (const match of types.matchAll(/<Override\b[^>]*PartName="([^"]+)"[^>]*\/>/g)) {
    const name = match[1].replace(/^\//, "")
    if (!zip.file(name)) problems.push(`内容类型指向不存在的 ${name}`)
  }
  const referenced = await referencedParts(zip)
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/(?:charts|embeddings)\//.test(name) || name.endsWith("/")) continue
    if (!referenced.has(name)) problems.push(`未被使用的 ${name}`)
  }
  const app = zip.file("docProps/app.xml")
  if (app) {
    const xml = await app.async("string")
    const declared = Number(xml.match(/<Slides>(\d+)<\/Slides>/)?.[1] ?? -1)
    const heading = headingCount(xml)
    const titles = xml.match(/<TitlesOfParts><vt:vector size="(\d+)"[^>]*>([\s\S]*?)<\/vt:vector>/)
    const inner = titles ? [...titles[2].matchAll(/<vt:lpstr>/g)].length : -1
    if (declared !== slideCount || heading !== slideCount) problems.push("文档属性里的页数与实际不符")
    if (!titles || Number(titles[1]) !== inner) problems.push("文档属性里的标题清单对不上")
  }
  return problems
}

function slideSize(presentation) {
  const match = presentation.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
  return { cx: Number(match?.[1] ?? 12192000), cy: Number(match?.[2] ?? 6858000) }
}

function contentBox(layoutXml, slide) {
  let best
  for (const pic of layoutXml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)) {
    const off = pic[0].match(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"/)
    if (!off) continue
    const box = { x: Number(off[1]), y: Number(off[2]), cx: Number(off[3]), cy: Number(off[4]) }
    if (!best || box.cx * box.cy > best.cx * best.cy) best = box
  }
  if (!best || best.cx < 1000000 || best.cy < 1000000) {
    return { x: 480000, y: 1280000, cx: Math.max(slide.cx - 960000, 4000000), cy: Math.max(slide.cy - 1760000, 3000000) }
  }
  const left = Math.round(best.cx * 0.04)
  const right = Math.round(best.cx * 0.07)
  const top = Math.round(best.cy * 0.04)
  const bottom = Math.round(best.cy * 0.22)
  const box = {
    x: best.x + left,
    y: best.y + top,
    cx: Math.max(best.cx - left - right, 2000000),
    cy: Math.max(best.cy - top - bottom, 1800000),
  }
  const anchor = titleAnchor(layoutXml)
  if (anchor && anchor.x > 0 && Math.abs(anchor.x - box.x) < 3000000) {
    const right2 = box.x + box.cx
    box.x = anchor.x
    box.cx = Math.max(right2 - box.x, 2000000)
  }
  return box
}

/** X of the layout's title placeholder, so body text lines up under it. */
function titleAnchor(layoutXml) {
  const match = /<p:sp>[\s\S]*?<p:ph type="title"[\s\S]*?<\/p:sp>/.exec(layoutXml)
  if (!match) return null
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(match[0])
  return off ? { x: Number(off[1]), y: Number(off[2]) } : null
}

function titleShape(title, ids) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${ids.n++}" name="标题"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" altLang="en-US" dirty="0"/><a:t>${escapeXml(title)}</a:t></a:r></a:p></p:txBody></p:sp>`
}

function textShape(pieces, box, ids, scale = 1) {
  const body = (pieces.length > 0 ? pieces : [{ role: "body", text: "未提供" }])
    .map((piece) => paragraph(piece.text, piece.role, scale))
    .join("")
  return `<p:sp><p:nvSpPr><p:cNvPr id="${ids.n++}" name="正文"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="100000" tIns="60000" rIns="100000" bIns="40000" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`
}

function tableShape(rows, box, ids, rowHeights) {
  const width = Math.max(...rows.map((row) => row.length), 1)
  const columns = splitExtent(box.cx, width)
  const heights = Array.isArray(rowHeights) && rowHeights.length === rows.length
    ? rowHeights
    : rows.map((row, rowIndex) => estimateRowHeight(row, columns, rowIndex === 0))
  const totalH = Math.min(
    heights.reduce((sum, value) => sum + value, 0),
    box.cy,
  )
  const grid = columns.map((value) => `<a:gridCol w="${value}"/>`).join("")
  const trs = rows
    .map((row, rowIndex) => {
      const cells = Array.from({ length: width }, (_, index) => cell(row[index] ?? "", rowIndex === 0)).join("")
      return `<a:tr h="${heights[rowIndex]}">${cells}</a:tr>`
    })
    .join("")
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${ids.n++}" name="表格"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${totalH}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}

function splitExtent(total, count) {
  const safeCount = Math.max(count, 1)
  const base = Math.max(Math.floor(total / safeCount), 1)
  const values = Array.from({ length: safeCount }, () => base)
  const drift = total - base * safeCount
  values[values.length - 1] = Math.max(values[values.length - 1] + drift, 1)
  return values
}

const CHART_COLORS = ["0070C0", "00A3E0", "1F4E79", "5BC0DE", "3D7EA6", "0E6E8C", "7FB3D5", "148F77"]

function chartShapes(chart, box, ids) {
  const series = chartSeries(chart.rows)
  if (series.length === 0) return textShape([{ role: "body", text: "未提供" }], box, ids)
  const trend = series.some((item) => /年|月/.test(item.label))
  const type = chart.type === "bar" && trend ? "column" : chart.type
  if (type === "pie") return pieShapes(series, box, ids)
  if (type === "column") return columnShapes(series, box, ids)
  return barShapes(series, box, ids)
}

function chartSeries(rows) {
  const body = rows.slice(1).filter((row) => row.some((cell) => clean(cell)))
  if (body.length === 0) return []
  const width = Math.max(...rows.map((row) => row.length))
  let valueIndex = -1
  for (let index = width - 1; index >= 0; index -= 1) {
    const count = body.filter((row) => measureOf(row[index]) !== null).length
    if (count === body.length) {
      valueIndex = index
      break
    }
  }
  if (valueIndex < 0) return []
  const labelIndex = valueIndex === 0 ? Math.min(1, width - 1) : 0
  if (labelIndex === valueIndex) return []
  return body
    .map((row) => ({
      label: clean(row[labelIndex] ?? row[0] ?? ""),
      value: numberOf(row[valueIndex]),
      display: clean(row[valueIndex] ?? ""),
    }))
    .filter((item) => item.label && item.value !== null && item.value >= 0)
    .slice(0, 12)
}

function barShapes(series, box, ids) {
  const max = Math.max(...series.map((item) => item.value), 1)
  const labelW = Math.round(box.cx * 0.28)
  const gap = 120000
  const plotX = box.x + labelW + gap
  const plotW = Math.max(box.cx - labelW - gap - 760000, Math.round(box.cx * 0.4))
  const rowH = Math.floor(box.cy / series.length)
  const barH = Math.max(Math.round(rowH * 0.46), 120000)
  const parts = []
  series.forEach((item, index) => {
    const y = box.y + index * rowH
    const barW = Math.max(Math.round((item.value / max) * plotW), 80000)
    const color = CHART_COLORS[index % CHART_COLORS.length]
    parts.push(plainText(ids, item.label, box.x, y, labelW, rowH, "333333", 1400, "r"))
    parts.push(rect(ids, plotX, y + Math.round((rowH - barH) / 2), barW, barH, color))
    parts.push(plainText(ids, item.display || formatNumber(item.value), plotX + barW + 60000, y, 680000, rowH, "333333", 1200, "l"))
  })
  return parts.join("")
}

function columnShapes(series, box, ids) {
  const max = Math.max(...series.map((item) => item.value), 1)
  const gap = Math.round(box.cx * 0.04)
  const colW = Math.max(Math.floor((box.cx - gap * (series.length + 1)) / series.length), 200000)
  const plotH = Math.round(box.cy * 0.62)
  const baseY = box.y + plotH
  const parts = []
  series.forEach((item, index) => {
    const height = Math.max(Math.round((item.value / max) * (plotH - 300000)), 80000)
    const x = box.x + gap + index * (colW + gap)
    const color = CHART_COLORS[index % CHART_COLORS.length]
    const barW = Math.round(colW * 0.62)
    parts.push(rect(ids, x + Math.round((colW - barW) / 2), baseY - height, barW, height, color))
    parts.push(plainText(ids, item.display || formatNumber(item.value), x, baseY - height - 280000, colW, 260000, "333333", 1200, "ctr"))
    parts.push(plainText(ids, item.label, x, baseY + 60000, colW, Math.max(box.y + box.cy - baseY - 80000, 280000), "333333", 1200, "ctr"))
  })
  return parts.join("")
}

function pieShapes(series, box, ids) {
  const total = series.reduce((sum, item) => sum + item.value, 0) || 1
  const size = Math.min(Math.round(box.cx * 0.42), Math.round(box.cy * 0.82))
  const pieX = box.x + Math.round(box.cx * 0.04)
  const pieY = box.y + Math.round((box.cy - size) / 2)
  let angle = -90
  const parts = []
  series.forEach((item, index) => {
    const sweep = (item.value / total) * 360
    if (sweep <= 0) return
    parts.push(pieSlice(ids, pieX, pieY, size, angle, sweep, CHART_COLORS[index % CHART_COLORS.length]))
    angle += sweep
  })
  const legendX = pieX + size + 280000
  const legendW = Math.max(box.x + box.cx - legendX, 1600000)
  const rowH = Math.floor(box.cy / series.length)
  series.forEach((item, index) => {
    const y = box.y + index * rowH
    const color = CHART_COLORS[index % CHART_COLORS.length]
    const swatch = Math.min(180000, Math.round(rowH * 0.35))
    parts.push(rect(ids, legendX, y + Math.round((rowH - swatch) / 2), swatch, swatch, color))
    const share = Math.round((item.value / total) * 1000) / 10
    parts.push(plainText(ids, `${item.label}  ${item.display || formatNumber(item.value)}（${share}%）`, legendX + swatch + 100000, y, legendW - swatch - 100000, rowH, "333333", 1400, "l"))
  })
  return parts.join("")
}

function fixedAngle(degrees) {
  const turn = 21_600_000
  const raw = Math.round(degrees * 60_000)
  return ((raw % turn) + turn) % turn
}

function pieSlice(ids, x, y, size, startDeg, sweepDeg, color) {
  const rot = fixedAngle(startDeg)
  const adj = Math.min(Math.max(Math.round(sweepDeg * 60_000), 1), 21_599_999)
  return `<p:sp><p:nvSpPr><p:cNvPr id="${ids.n++}" name="扇形"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm rot="${rot}"><a:off x="${x}" y="${y}"/><a:ext cx="${size}" cy="${size}"/></a:xfrm><a:prstGeom prst="pie"><a:avLst><a:gd name="adj1" fmla="val ${adj}"/><a:gd name="adj2" fmla="val 0"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`
}

function rect(ids, x, y, cx, cy, color) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${ids.n++}" name="矩形"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 8000"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`
}

function plainText(ids, text, x, y, cx, cy, color, size, align) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${ids.n++}" name="标注"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.max(Math.round(cx), 100000)}" cy="${Math.max(Math.round(cy), 100000)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="ctr" lIns="40000" rIns="40000"/><a:lstStyle/><a:p><a:pPr algn="${align}"><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="${size}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>${escapeXml(text) || " "}</a:t></a:r></a:p></p:txBody></p:sp>`
}

/** A cell is a measure only when the whole cell is one number plus an optional unit. */
function measureOf(value) {
  const text = clean(String(value ?? "")).replace(/\s+/g, "").replace(/,/g, "")
  if (!text || text.length > 18) return null
  const match = /^(?:约|大约|超过|不足|近)?(-?\d+(?:\.\d+)?)(%|％|万辆|万元|万人|万个|万吨|亿辆|亿元|个|人|元|辆)?$/.exec(text)
  if (!match) return null
  const digits = match[1].replace("-", "").replace(".", "")
  if (!match[1].includes(".") && digits.length > 6) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return null
  return amount
}

function numberOf(value) {
  const text = String(value ?? "").replace(/,/g, "")
  const match = /-?\d+(?:\.\d+)?/.exec(text.replace(/%/g, ""))
  if (!match) return null
  const amount = Number(match[0])
  if (!Number.isFinite(amount)) return null
  return amount
}

function formatNumber(value) {
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

function cell(text, header) {
  const fill = header ? "0070C0" : "FFFFFF"
  const color = header ? "FFFFFF" : "333333"
  const bold = header ? ' b="1"' : ""
  return `<a:tc><a:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="${header ? "ctr" : "l"}"/><a:r><a:rPr lang="zh-CN" sz="1200"${bold} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>${escapeXml(text) || " "}</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr></a:tc>`
}

function paragraph(text, role, scale = 1) {
  const value = escapeXml(text) || " "
  const sz = (base) => String(Math.max(Math.round(base * scale), 1000))
  const before = (base) => String(Math.max(Math.round(base * scale), 100))
  if (role === "bullet") {
    return `<a:p><a:pPr marL="228600" indent="-228600"><a:lnSpc><a:spcPct val="112000"/></a:lnSpc><a:spcBef><a:spcPts val="${before(220)}"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="${sz(1500)}" dirty="0"><a:solidFill><a:srgbClr val="333333"/></a:solidFill><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>${value}</a:t></a:r></a:p>`
  }
  if (role === "subtitle") {
    return `<a:p><a:pPr><a:lnSpc><a:spcPct val="115000"/></a:lnSpc><a:spcBef><a:spcPts val="${before(560)}"/></a:spcBef><a:spcAft><a:spcPts val="${before(200)}"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="${sz(1900)}" b="1" dirty="0"><a:solidFill><a:srgbClr val="0070C0"/></a:solidFill><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>${value}</a:t></a:r></a:p>`
  }
  return `<a:p><a:pPr><a:lnSpc><a:spcPct val="115000"/></a:lnSpc><a:spcBef><a:spcPts val="${before(260)}"/></a:spcBef><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="${sz(1500)}" dirty="0"><a:solidFill><a:srgbClr val="333333"/></a:solidFill><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>${value}</a:t></a:r></a:p>`
}

function replaceFirstRun(shape, text) {
  let used = false
  return shape.replace(/<a:t([^>]*)>([^<]*)<\/a:t>/g, (full, attrs) => {
    if (used) return `<a:t${attrs}></a:t>`
    used = true
    return `<a:t${attrs}>${escapeXml(text)}</a:t>`
  })
}

const SLIDE_HEADING = "(?:幻灯片标题|投影片標題|Slide Titles)"

function headingCount(xml) {
  const match = xml.match(new RegExp(`${SLIDE_HEADING}</vt:lpstr></vt:variant><vt:variant><vt:i4>(\\d+)`))
  return match ? Number(match[1]) : -1
}

function fixApp(xml, titles) {
  const count = titles.length
  let next = xml.replace(/<Slides>\d+<\/Slides>/, `<Slides>${count}</Slides>`)
  const oldCount = headingCount(xml)
  next = next.replace(
    new RegExp(`(${SLIDE_HEADING}</vt:lpstr></vt:variant><vt:variant><vt:i4>)\\d+(</vt:i4>)`),
    `$1${count}$2`,
  )
  if (oldCount < 1) return next
  return next.replace(/<TitlesOfParts><vt:vector size="\d+"[^>]*>([\s\S]*?)<\/vt:vector><\/TitlesOfParts>/, (full, body) => {
    const parts = [...body.matchAll(/<vt:lpstr>([^<]*)<\/vt:lpstr>/g)].map((match) => match[1])
    const head = parts.slice(0, Math.max(parts.length - oldCount, 0))
    const merged = [...head, ...titles.map((item) => escapeXml(item))]
    return `<TitlesOfParts><vt:vector size="${merged.length}" baseType="lpstr">${merged.map((item) => `<vt:lpstr>${item}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts>`
  })
}

function slideText(xml) {
  return [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((match) => decodeXml(match[1] ?? "")).join("")
}

function chunk(items, size) {
  const groups = []
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size))
  return groups.length > 0 ? groups : [[]]
}

function maxRel(xml) {
  const ids = [...xml.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]))
  return ids.length > 0 ? Math.max(...ids) : 1
}

function clean(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function cleanInline(value) {
  return clean(value)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#]/g, "")
}

function escapeXml(value) {
  return clean(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}
