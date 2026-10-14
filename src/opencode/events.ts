import type { OpencodeClient } from "./client.js"
import type { OpencodeEvent } from "./types.js"
import type { OpencodeService } from "./service.js"
import type { Logger } from "../util/logger.js"

export type EventListener = (event: OpencodeEvent) => void

/**
 * A single shared subscription to the OpenCode live event stream with
 * automatic reconnection. Subscribers register once and keep receiving events
 * across reconnects. Listeners must be cheap and non-blocking; heavy work
 * should be queued by the consumer.
 */
export class OpencodeEventBus {
  private readonly listeners = new Set<EventListener>()
  private readonly connectListeners = new Set<() => void>()
  private running = false
  private abort?: AbortController
  private connected = false
  private lastEvent?: OpencodeEvent
  private client?: OpencodeClient

  constructor(
    private readonly service: OpencodeService,
    private readonly logger: Logger,
  ) {}

  get isConnected(): boolean {
    return this.connected
  }

  get last(): OpencodeEvent | undefined {
    return this.lastEvent
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Subscribe to events of a single type. Returns an unsubscribe function. */
  on<T extends OpencodeEvent = OpencodeEvent>(type: string, handler: (event: T) => void): () => void {
    return this.subscribe((event) => {
      if (event.type === type) handler(event as T)
    })
  }

  /** Called after a (re)connection is established so consumers can resync. */
  onConnect(listener: () => void): () => void {
    this.connectListeners.add(listener)
    return () => this.connectListeners.delete(listener)
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.abort?.abort()
  }

  private async loop(): Promise<void> {
    let backoff = 1_000
    while (this.running) {
      this.abort = new AbortController()
      try {
        this.client = await this.service.client()
        for await (const event of this.client.streamEvents(this.abort.signal)) {
          const wasDisconnected = !this.connected
          this.connected = true
          backoff = 1_000
          if (wasDisconnected) {
            this.logger.debug("Event stream connected")
            for (const listener of this.connectListeners) safeCall(() => listener())
          }
          this.lastEvent = event
          for (const listener of this.listeners) safeCall(() => listener(event))
        }
        this.logger.warn("Event stream ended")
      } catch (error) {
        if (this.running) {
          this.logger.warn("Event stream error", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        this.connected = false
      }
      if (!this.running) break
      await delay(backoff)
      backoff = Math.min(backoff * 2, 30_000)
      // The service may have been restarted; force re-discovery.
      this.service.invalidate()
    }
  }
}

function safeCall(fn: () => void): void {
  try {
    fn()
  } catch {
    // listeners must not break the bus
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
