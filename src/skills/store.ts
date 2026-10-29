import fs from "node:fs"
import path from "node:path"
import { readJson, writeJson } from "../util/jsonfile.js"
import { safeSegment } from "../util/paths.js"

/**
 * 个性化技能：用户在飞书卡片里自己攒出来的工作方法。
 *
 * 存在桥接侧（`<storageDir>/skills/`），不写进 OpenCode 项目——OpenCode 只在项目根
 * 发现技能，做不到"每人一个技能目录"。命中触发词后由桥接把技能正文注入 prompt，
 * 因此个人隔离、创建即可用、也不需要改 PM-Agent 仓库。
 */
export type SkillScope = "personal" | "shared"

export interface Skill {
  id: string
  name: string
  /** 命中词：用户原话里出现任意一个即视为要用这条技能。 */
  triggers: string[]
  /** 适用场景，一句话。 */
  scene: string
  /** 执行步骤与要求（正文）。 */
  steps: string
  /** 输出要求。 */
  output: string
  owner: string
  ownerName?: string
  scope: SkillScope
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  useCount: number
}

export interface SkillDraft {
  id?: string
  name: string
  triggers: string[]
  scene?: string
  steps: string
  output?: string
  scope?: SkillScope
}

export interface SkillMatch {
  skill: Skill
  trigger: string
  /** 命中强度：显式点名 > 触发词，长触发词 > 短触发词。 */
  weight: number
}

const MAX_NAME = 24
const MAX_TRIGGERS = 8
const MAX_TRIGGER_LEN = 20
const MAX_SCENE = 200
const MAX_OUTPUT = 300
const MAX_STEPS = 1000
/** 同一个技能最多同时命中几条，避免一次注入太多互相打架。 */
const MAX_MATCHES = 2

const SHARED_DIR = "_shared"
/** 「用XX技能」「@XX」「技能：XX」——用户直接点名，优先级最高。 */
const EXPLICIT_PATTERNS = [/用\s*([^\s，。,.!！?？]{2,24})\s*技能/, /@\s*([^\s，。,.!！?？]{2,24})/, /技能\s*[:：]\s*([^\s，。,.!！?？]{2,24})/]

function byUpdatedDesc(a: Skill, b: Skill): number {
  return b.updatedAt - a.updatedAt
}

/** 触发词分隔：中英文逗号、顿号、分号、空格都当分隔符。 */
export function parseTriggers(input: string): string[] {
  return input
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_TRIGGERS)
}

export function validateSkillDraft(draft: SkillDraft): string | undefined {
  const name = draft.name?.trim() ?? ""
  if (name.length < 2) return "技能名称至少 2 个字。"
  if (name.length > MAX_NAME) return `技能名称最多 ${MAX_NAME} 个字。`
  const triggers = (draft.triggers ?? []).map((t) => t.trim()).filter(Boolean)
  if (triggers.length === 0) return "请至少填一个触发词，否则这条技能永远不会被用到。"
  if (triggers.length > MAX_TRIGGERS) return `触发词最多 ${MAX_TRIGGERS} 个。`
  if (triggers.some((t) => t.length < 2)) return "触发词至少 2 个字（太短容易误命中）。"
  if (triggers.some((t) => t.length > MAX_TRIGGER_LEN)) return `单个触发词最多 ${MAX_TRIGGER_LEN} 个字。`
  const steps = draft.steps?.trim() ?? ""
  if (steps.length < 10) return "执行步骤至少写 10 个字，太短的话模型没法照着做。"
  if (steps.length > MAX_STEPS) return `执行步骤最多 ${MAX_STEPS} 字。`
  if ((draft.scene ?? "").length > MAX_SCENE) return `适用场景最多 ${MAX_SCENE} 字。`
  if ((draft.output ?? "").length > MAX_OUTPUT) return `输出要求最多 ${MAX_OUTPUT} 字。`
  return undefined
}

/** 把技能渲染成注入 prompt 的文本块。 */
export function renderSkillBlock(skill: Skill): string {
  const lines = [
    `【个性化技能：${skill.name}】`,
    skill.scene ? `适用场景：${skill.scene}` : "",
    "执行步骤与要求：",
    skill.steps.trim(),
    skill.output ? `输出要求：${skill.output.trim()}` : "",
    "（这条技能由用户本人保存。调用子 Agent 时，把上面「执行步骤与要求」和「输出要求」原样写进任务说明；" +
      "与用户本次当场说的指令冲突时，以当场指令为准。）",
  ]
  return lines.filter((line) => line !== "").join("\n")
}

export class SkillStore {
  private readonly root: string

  constructor(storageDir: string) {
    this.root = path.join(storageDir, "skills")
  }

  private dirOf(scope: SkillScope, owner: string): string {
    return scope === "shared" ? path.join(this.root, SHARED_DIR) : path.join(this.root, safeSegment(owner))
  }

  private filesIn(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(dir, name))
    } catch {
      return []
    }
  }

  private readScope(scope: SkillScope, owner: string): Skill[] {
    const dir = this.dirOf(scope, owner)
    const skills: Skill[] = []
    for (const file of this.filesIn(dir)) {
      const skill = readJson<Skill | undefined>(file, undefined)
      if (skill && typeof skill.id === "string" && skill.name) skills.push({ ...skill, scope })
    }
    return skills
  }

  /** 我的个人技能（新的在前）。 */
  personal(owner: string): Skill[] {
    return this.readScope("personal", owner).sort(byUpdatedDesc)
  }

  /** 全员共享技能（管理员维护）。 */
  shared(): Skill[] {
    return this.readScope("shared", "").sort(byUpdatedDesc)
  }

  /** 我当前能用的全部技能：个人优先，其次共享。 */
  list(owner: string): Skill[] {
    return [...this.personal(owner), ...this.shared()]
  }

  /** 按 id 或名称找技能；同名时个人技能优先。 */
  get(owner: string, idOrName: string): Skill | undefined {
    const needle = idOrName.trim()
    if (!needle) return undefined
    const own = this.personal(owner)
    return (
      own.find((skill) => skill.id === needle) ??
      own.find((skill) => skill.name === needle) ??
      this.shared().find((skill) => skill.id === needle) ??
      this.shared().find((skill) => skill.name === needle)
    )
  }

  /** 新建或更新。共享技能需要调用方先做管理员校验（allowShared）。 */
  save(owner: string, draft: SkillDraft, options: { allowShared?: boolean; ownerName?: string } = {}): Skill {
    const problem = validateSkillDraft(draft)
    if (problem) throw new Error(problem)
    const scope: SkillScope = draft.scope ?? "personal"
    if (scope === "shared" && !options.allowShared) throw new Error("共享技能只有管理员可以维护。")

    const name = draft.name.trim()
    const triggers = [...new Set(parseTriggers(draft.triggers.join(" ")))]
    const existing = draft.id ? this.get(owner, draft.id) : undefined
    const createdAt = existing?.createdAt ?? Date.now()

    const clash = this.list(owner).find(
      (skill) => skill.scope === scope && skill.name === name && skill.id !== existing?.id,
    )
    if (clash) throw new Error(`已经有一条同名技能「${name}」，换个名字，或者直接编辑那一条。`)

    const skill: Skill = {
      id: existing?.id ?? `sk_${Math.random().toString(16).slice(2, 10)}`,
      name,
      triggers,
      scene: (draft.scene ?? "").trim(),
      steps: draft.steps.trim(),
      output: (draft.output ?? "").trim(),
      owner: scope === "shared" ? existing?.owner ?? owner : owner,
      ownerName: options.ownerName ?? existing?.ownerName,
      scope,
      createdAt,
      updatedAt: Date.now(),
      lastUsedAt: existing?.lastUsedAt,
      useCount: existing?.useCount ?? 0,
    }

    // 改了可见性：老文件要挪位置，否则会留在原目录里变成幽灵记录。
    if (existing && existing.scope !== scope) this.removeFile(existing)
    writeJson(path.join(this.dirOf(scope, owner), `${skill.id}.json`), skill)
    if (skill.scope === "shared") fs.mkdirSync(this.dirOf("shared", ""), { recursive: true })
    return skill
  }

  remove(owner: string, idOrName: string, options: { allowShared?: boolean } = {}): Skill | undefined {
    const skill = this.get(owner, idOrName)
    if (!skill) return undefined
    if (skill.scope === "shared" ? !options.allowShared : skill.owner !== owner) return undefined
    this.removeFile(skill)
    return skill
  }

  private removeFile(skill: Skill): void {
    try {
      fs.rmSync(path.join(this.dirOf(skill.scope, skill.owner), `${skill.id}.json`), { force: true })
    } catch {
      /* 已经被删掉就当作成功 */
    }
  }

  /** 记录一次使用（用于「常用」排序和卡片上的次数）。 */
  markUsed(skill: Skill): void {
    try {
      writeJson(path.join(this.dirOf(skill.scope, skill.owner), `${skill.id}.json`), {
        ...skill,
        useCount: skill.useCount + 1,
        lastUsedAt: Date.now(),
      })
    } catch {
      /* 计数失败不影响这次对话 */
    }
  }

  /**
   * 命中判定：显式点名（「用XX技能」「@XX」）优先，其次是触发词子串，
   * 同类里取更长的触发词（更具体）。最多返回 MAX_MATCHES 条。
   */
  match(text: string, owner: string): SkillMatch[] {
    const hay = text.toLowerCase()
    if (!hay.trim()) return []
    const skills = this.list(owner)
    if (skills.length === 0) return []

    const hits = new Map<string, SkillMatch>()
    const consider = (skill: Skill, trigger: string, weight: number) => {
      const current = hits.get(skill.id)
      if (!current || weight > current.weight) hits.set(skill.id, { skill, trigger, weight })
    }

    for (const skill of skills) {
      const name = skill.name.toLowerCase()
      for (const pattern of EXPLICIT_PATTERNS) {
        const named = pattern.exec(text)?.[1]?.toLowerCase()
        if (named && (named === name || name.includes(named) || named.includes(name))) {
          consider(skill, skill.name, 1000 + name.length)
        }
      }
      for (const trigger of skill.triggers) {
        const needle = trigger.toLowerCase()
        if (needle.length >= 2 && hay.includes(needle)) consider(skill, trigger, needle.length)
      }
    }

    return [...hits.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_MATCHES)
  }
}

/** 卡片上展示的一行摘要。 */
export function describeSkill(skill: Skill): string {
  const scope = skill.scope === "shared" ? "共享" : "个人"
  const used = skill.useCount > 0 ? ` · 用过 ${skill.useCount} 次` : ""
  const triggers = skill.triggers.map((t) => `「${t}」`).join("、")
  const scene = skill.scene ? `\n适用：${skill.scene}` : ""
  return `**${skill.name}**（${scope}${used}）\n触发词：${triggers}${scene}`
}
