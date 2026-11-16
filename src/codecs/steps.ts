// Decoders written as generators: they yield between steps (a bzip2 block, an LZMA2 chunk, 64 KiB
// of GZIP or Zstandard input), so the same code can run straight through, or give the thread
// back now and then and stop when its result is no longer wanted. Everything runs on the editor
// frame's one thread; this is what lets a newer document stop the work for an older one.

export type Steps<T> = Generator<void, T, void>

/** Thrown by runAsync when `cancelled()` turned true: the result is no longer wanted. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

/** Runs the steps straight through. */
export function run<T>(steps: Steps<T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

export type Pacing = {
  /** True once the result is no longer wanted. */
  cancelled: () => boolean
  /** Longest stretch of work between pauses, in milliseconds (default 40). */
  every?: number
}

/** Runs the steps, giving the thread back about every `every` ms and stopping when cancelled. */
export async function runAsync<T>(steps: Steps<T>, pacing: Pacing): Promise<T> {
  const every = pacing.every ?? 40
  let since = Date.now()
  try {
    for (;;) {
      const next = steps.next()
      if (next.done) return next.value
      if (Date.now() - since < every) continue
      await pause()
      if (pacing.cancelled()) throw new CancelledError()
      since = Date.now()
    }
  } finally {
    steps.return(undefined as T)
  }
}

/**
 * Lets the frame's other tasks run (a new document, input, painting). A message, not a zero
 * timeout: browsers wait at least 4 ms for nested timeouts, which would slow unpacking by a tenth.
 */
function pause(): Promise<void> {
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      resolve()
    }
    port2.postMessage(null)
  })
}
