/** A simple async queue that can be iterated with `for await`. */
export class AsyncQueue<T> {
  private readonly values: T[] = []
  private resolvers: ((value: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const resolver = this.resolvers.shift()
    if (resolver) resolver({ value, done: false })
    else this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const resolver of this.resolvers) resolver({ value: undefined as never, done: true })
    this.resolvers = []
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.resolvers.push(resolve))
      },
    }
  }
}

/**
 * Serializes async work per key. Used to ensure only one prompt runs per
 * OpenCode session at a time while allowing different sessions to run
 * concurrently.
 */
export class KeyedSerial {
  private readonly chains = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.chains.set(
      key,
      next.catch(() => undefined),
    )
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    return next
  }

  isBusy(key: string): boolean {
    return this.chains.has(key)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A throttle that coalesces rapid calls into at most one per interval. */
export function createThrottle(intervalMs: number): (task: () => void) => void {
  let last = 0
  let timer: NodeJS.Timeout | undefined
  let pending = false
  return (task: () => void) => {
    const now = Date.now()
    const elapsed = now - last
    if (elapsed >= intervalMs) {
      last = now
      task()
      return
    }
    pending = true
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      if (!pending) return
      pending = false
      last = Date.now()
      task()
    }, intervalMs - elapsed)
  }
}
