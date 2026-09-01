import type { Clock } from "../domain/ports";
import type { EpochMilliseconds } from "../domain/entities";

export class SystemClock implements Clock {
  now(): EpochMilliseconds {
    return Date.now();
  }
}

export class FixedClock implements Clock {
  constructor(private readonly timestamp: EpochMilliseconds) {}

  now(): EpochMilliseconds {
    return this.timestamp;
  }
}

export const systemClock: Clock = new SystemClock();
