import type { EpochMilliseconds } from "./entities";

/** Supplies time to domain operations instead of reading the platform clock. */
export interface Clock {
  now(): EpochMilliseconds;
}

/** Supplies application IDs to domain operations instead of generating them inline. */
export interface IdGenerator {
  next(namespace?: string): string;
}
