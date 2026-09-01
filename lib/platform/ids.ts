import type { IdGenerator } from "../domain/ports";

export class RandomIdGenerator implements IdGenerator {
  next(namespace = "id"): string {
    const randomUuid = globalThis.crypto?.randomUUID;
    const value = randomUuid
      ? randomUuid.call(globalThis.crypto)
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    return `${namespace}-${value}`;
  }
}

/** A deterministic port implementation for contract and application tests. */
export class SequenceIdGenerator implements IdGenerator {
  private position = 0;

  constructor(private readonly values: readonly string[]) {}

  next(namespace?: string): string {
    void namespace;
    const value = this.values[this.position];
    if (value === undefined) {
      throw new Error("The deterministic ID sequence is exhausted.");
    }

    this.position += 1;
    return value;
  }
}

export const randomIdGenerator: IdGenerator = new RandomIdGenerator();
