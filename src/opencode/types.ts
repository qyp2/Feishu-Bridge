/** Reference to a model registered with OpenCode. */
export interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

export interface SessionInfo {
  id: string
  projectID: string
  agent?: string
  model?: ModelRef
  cost?: number
  title?: string
  time: { created: number; updated: number }
  location?: { directory?: string }
  metadata?: Record<string, unknown>
}

export interface PromptFileAttachment {
  uri: string
  name?: string
  description?: string
}

export interface PromptInput {
  text: string
  files?: PromptFileAttachment[]
  agents?: { name: string }[]
  skills?: { name: string }[]
  metadata?: Record<string, unknown>
  delivery?: "steer" | "queue"
  resume?: boolean
}

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  message?: string
}

export type PermissionReply = "once" | "always" | "reject"

export type FormValue = string | number | boolean | string[]

export interface FormOption {
  value: string
  label?: string
}

export interface FormField {
  key: string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  /** Discriminated by the `type` value. */
  type?: string
  options?: FormOption[]
  [extra: string]: unknown
}

export interface FormInfo {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: FormField[]
}

export interface AgentInfo {
  name: string
  description?: string
  mode?: string
  model?: ModelRef
}

export interface MessageInfo {
  id: string
  type: string
  text?: string
  time?: { created: number; completed?: number }
  agent?: string
  model?: ModelRef
  content?: unknown[]
  finish?: string
  tokens?: { input: number; output: number; reasoning: number }
  cost?: number
  error?: { type: string; message: string }
}

export interface SessionLog {
  info: SessionInfo
  messages: MessageInfo[]
}

/** A normalized OpenCode event (the `/api/event` payload shape). */
export interface OpencodeEvent<T = Record<string, unknown>> {
  id: string
  type: string
  created?: number
  location?: { directory?: string }
  data: T
  durable?: { aggregateID: string; seq: number; version: number }
}

export interface TextDeltaData {
  sessionID: string
  assistantMessageID: string
  ordinal: number
  delta: string
}

export interface TextEndedData {
  sessionID: string
  assistantMessageID: string
  ordinal: number
  text: string
}

export interface ReasoningDeltaData extends TextDeltaData {}

export interface ToolInputStartedData {
  sessionID: string
  assistantMessageID: string
  id: string
  name: string
}

export interface ToolCalledData {
  sessionID: string
  assistantMessageID: string
  id: string
  input?: unknown
  executed?: boolean
}

export interface ToolProgressData {
  sessionID: string
  assistantMessageID: string
  id: string
  metadata?: {
    toolCalls?: { tool: string; status: string; input?: unknown }[]
  }
}

export interface StepEndedData {
  sessionID: string
  assistantMessageID: string
  finish?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number }
}

export interface ExecutionData {
  sessionID: string
  error?: { type: string; message: string }
}
