import type { CardActionEvent } from "@larksuiteoapi/node-sdk"

/** Coerce Feishu form_value entries (string or occasional nested objects) to text. */
export function formFieldString(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(formFieldString).filter(Boolean).join(", ")
  if (typeof value === "object") {
    const o = value as Record<string, unknown>
    for (const key of ["value", "text", "content", "input", "default_value"]) {
      const hit = o[key]
      if (typeof hit === "string") return hit
    }
  }
  return ""
}

function flattenFormValues(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const map = raw as Record<string, unknown>
  const known = new Set([
    "skill_name",
    "name",
    "triggers",
    "scene",
    "steps",
    "output",
    "scope",
    "phone",
    "code",
    "instruction",
    "template",
    "cloud",
    "files",
  ])
  if (Object.keys(map).some((key) => known.has(key))) return map
  for (const value of Object.values(map)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const inner = value as Record<string, unknown>
    if (Object.keys(inner).some((key) => known.has(key))) return inner
  }
  return map
}

function collectFormValueCandidates(event: CardActionEvent): unknown[] {
  const action = event.action as { form_value?: unknown }
  const raw = event.raw as Record<string, unknown> | undefined
  const fromDeep = raw ? deepFormValueMaps(raw) : []
  return [
    action?.form_value,
    raw?.form_value,
    (raw?.action as { form_value?: unknown } | undefined)?.form_value,
    (raw?.event as { action?: { form_value?: unknown } } | undefined)?.action?.form_value,
    ...fromDeep,
  ]
}

function deepFormValueMaps(obj: unknown, depth = 0, seen = new WeakSet<object>()): unknown[] {
  if (!obj || typeof obj !== "object" || depth > 14) return []
  if (seen.has(obj as object)) return []
  seen.add(obj as object)
  const found: unknown[] = []
  if ("form_value" in (obj as object)) {
    const fv = (obj as { form_value: unknown }).form_value
    if (fv && typeof fv === "object") found.push(fv)
  }
  for (const value of Object.values(obj as Record<string, unknown>)) {
    found.push(...deepFormValueMaps(value, depth + 1, seen))
  }
  return found
}

/**
 * Read input values from a card `form` submit. The SDK normalizes `action` but
 * omits `form_value`; we merge every `form_value` blob found on `raw`.
 */
export function extractFormValues(event: CardActionEvent): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const candidate of collectFormValueCandidates(event)) {
    const flat = flattenFormValues(candidate)
    for (const [key, value] of Object.entries(flat)) {
      // 多选是数组。拼成字符串后，提交逻辑认不出「已经勾选」。
      if (Array.isArray(value)) {
        const items = formStringList(value) ?? []
        if (items.length > 0 || !(key in merged)) merged[key] = items
        continue
      }
      const text = formFieldString(value).trim()
      if (text !== "") merged[key] = text
      else if (!(key in merged)) merged[key] = value
    }
  }
  return merged
}

/** 多选字段。undefined 表示这次回调没带该字段。 */
export function formStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return value.map(formFieldString).map((item) => item.trim()).filter(Boolean)
  if (typeof value === "string") {
    const text = value.trim()
    return text ? [text] : []
  }
  const text = formFieldString(value).trim()
  return text ? [text] : []
}

/** Non-sensitive keys present in the last form submit (for audit debugging). */
export function formValueKeySummary(event: CardActionEvent): string[] {
  return Object.keys(extractFormValues(event)).sort()
}
