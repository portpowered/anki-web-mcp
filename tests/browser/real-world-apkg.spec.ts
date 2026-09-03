import { basename, delimiter } from "node:path";
import { expect, test } from "@playwright/test";

const packagePaths = (process.env.ANKI_REAL_APKG_PATHS ?? "")
  .split(delimiter)
  .map((value) => value.trim())
  .filter(Boolean);

test.use({ trace: "off" });

test.describe("local real-world APKG regression corpus", () => {
  test.skip(packagePaths.length === 0, "Set ANKI_REAL_APKG_PATHS to exercise local packages.");

  for (const [index, packagePath] of packagePaths.entries()) {
    test(`imports ${basename(packagePath)}`, async ({ page }) => {
      test.setTimeout(5 * 60_000);
      await page.goto("");
      const fixtureUrl = new URL(`__real-apkg__/${index}`, page.url()).toString();

      const observation = await page.evaluate(async (url) => {
        const packageBytes = await fetch(url).then((response) => response.arrayBuffer());
        return window.productionImportHarness.run(packageBytes);
      }, fixtureUrl);

      const diagnostic = JSON.stringify({
        ...observation,
        progress: `${observation.progress.length} events; last=${observation.progress.at(-1) ?? "none"}`,
      });
      expect(["success", "success-with-warnings"], diagnostic).toContain(observation.status);
      expect(observation.errorCode).toBeNull();
      expect(observation.terminalCount).toBe(1);
      expect(observation.monotonicProgress).toBe(true);
      expect(observation.committed?.decks).toBeGreaterThan(0);
      expect(observation.committed?.cards).toBeGreaterThan(0);
      expect(observation.committed?.media).toBeGreaterThan(0);
      expect(observation.committed?.mediaBytes).toBeGreaterThan(0);
      expect(
        (observation.committed?.imageMedia ?? 0) + (observation.committed?.audioMedia ?? 0),
      ).toBeGreaterThan(0);
      if (basename(packagePath).includes("Core2.3k")) {
        expect(observation.committed?.imageMedia).toBeGreaterThan(0);
        expect(observation.committed?.imageCards, diagnostic).toBeGreaterThan(0);
      }
      if (basename(packagePath).includes("Audio")) {
        expect(observation.committed?.audioMedia).toBeGreaterThan(0);
      }
      if (basename(packagePath).includes("Japanese_Core_2000")) {
        expect(observation.committed?.cards).toBe(2007);
        expect(observation.committed?.media).toBe(3970);
        expect(observation.committed?.furiganaCards).toBeGreaterThan(0);
        expect(observation.warnings.filter(({ code }) =>
          code === "UNSUPPORTED_TEMPLATE_FEATURE"
        )).toEqual([]);
        expect(observation.warnings.filter(({ code }) =>
          code === "UNSAFE_CONTENT_REMOVED"
        )).toHaveLength(2);
        expect(new Set(observation.warnings.filter(({ code }) =>
          code === "UNSAFE_CONTENT_REMOVED"
        ).map(({ sourceKind }) => sourceKind))).toEqual(
          new Set(["template", "model"]),
        );
      }
    });
  }
});
