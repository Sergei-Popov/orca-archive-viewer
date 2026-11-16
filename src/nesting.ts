// Limits for archives opened inside archives: each level keeps its archive in memory until the
// trail goes back past it, so the depth and the bytes held by all levels are capped.

import type { Archive } from './archive/model'
import { MAX_UNPACKED } from './archive/open'

/** Levels in the trail, the archive Orca opened included. */
export const MAX_LEVELS = 8
/** Bytes all levels together may hold besides the document Orca passed in. */
export const MAX_HELD = 1024 * 1024 * 1024

/** A nested archive was refused because the trail is already `MAX_LEVELS` deep. */
export class TooDeepError extends Error {
  readonly levels: number

  constructor(levels: number) {
    super(`archives nested deeper than ${levels} levels are not opened`)
    this.name = 'TooDeepError'
    this.levels = levels
  }
}

/**
 * How many bytes the next nested archive may unpack to, below `depth` open levels that hold
 * `held` bytes. Throws `TooDeepError` when the trail is full.
 */
export function nestedLimit(depth: number, held: number, maxLevels = MAX_LEVELS, maxHeld = MAX_HELD): number {
  if (depth >= maxLevels) throw new TooDeepError(maxLevels)
  return Math.max(0, Math.min(MAX_UNPACKED, maxHeld - held))
}

/**
 * Bytes a nested level keeps: the entry it was read from, plus the whole buffer a compressed
 * stream was unpacked into (which can be larger than the entries in it).
 */
export function heldBytes(archive: Archive, entryBytes: number): number {
  return entryBytes + archive.unpacked
}

/**
 * Whether a level opens straight into its only file, an archive (a `.zip.gz`). Only the archive
 * Orca opened does: a chain of `.gz` inside `.gz` then opens one level per click, not all at once.
 */
export function autoOpens(depth: number, archive: Archive): boolean {
  return depth === 1 && archive.kind === 'single'
}
