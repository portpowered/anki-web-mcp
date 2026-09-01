import { describe, expect, test } from "bun:test";
import { assetPath, defaultBasePath } from "./site";

describe("static site paths", () => {
  test("keeps public assets below the project base path", () => {
    expect(assetPath("/diagnostic-mark.svg")).toBe(
      `${defaultBasePath}/diagnostic-mark.svg`,
    );
  });

  test("normalizes asset paths without changing the base path", () => {
    expect(assetPath("diagnostic-mark.svg")).toBe(
      `${defaultBasePath}/diagnostic-mark.svg`,
    );
  });
});
