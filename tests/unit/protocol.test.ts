import { expect, test } from "bun:test";
import { STACK_STAGES } from "../../spikes/apkg-compatibility/src/protocol";

test("the staged protocol covers every selected parser category in order", () => {
  expect([...STACK_STAGES]).toEqual([
    "zip",
    "sqlite",
    "zstd",
    "protobuf",
    "sanitizer",
  ]);
});
