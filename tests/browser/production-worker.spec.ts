import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const fixturePath = resolve(
  "spikes",
  "apkg-compatibility",
  "fixtures",
  "synthetic",
  "legacy-anki2.apkg",
);

test.describe("production import Worker boundary", () => {
  test("runs the application service off-thread with protected commit data", async ({ page }) => {
    const bytes = new Uint8Array(await readFile(fixturePath));
    const externalRequests: string[] = [];
    const expectedOrigin = new URL(
      process.env.APKG_BROWSER_BASE_URL
        ?? `http://127.0.0.1:${process.env.APKG_BROWSER_PORT ?? "4173"}/`,
    ).origin;
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== expectedOrigin) {
        externalRequests.push(request.url());
      }
    });
    await page.goto("");

    const observation = await page.evaluate(
      (fixture) => window.productionImportHarness.run(new Uint8Array(fixture)),
      [...bytes],
    );

    expect(observation.status, JSON.stringify(observation)).toBe("success");
    expect(observation.errorCode).toBeNull();
    expect(observation.terminalCount).toBe(1);
    expect(observation.monotonicProgress).toBe(true);
    expect([...new Set(observation.progress)]).toEqual([
      "preflight",
      "validating-archive",
      "decompressing-collection",
      "parsing-records",
      "compiling-content",
      "importing-media",
    ]);
    expect(observation.heartbeatDelta).toBeGreaterThan(0);
    expect(observation.committed).toMatchObject({
      layout: "legacy-anki2",
      decks: 2,
      cards: 4,
      media: 2,
      graphFrozen: true,
      recordsFrozen: true,
    });
    expect(observation.committed?.mediaBytes).toBeGreaterThan(0);
    expect(externalRequests).toEqual([]);
  });

  test("cancellation at a production stage terminates without commit readiness", async ({ page }) => {
    const bytes = new Uint8Array(await readFile(fixturePath));
    await page.goto("");

    const observation = await page.evaluate(
      (fixture) => window.productionImportHarness.run(
        new Uint8Array(fixture),
        "validating-archive",
      ),
      [...bytes],
    );

    expect(observation).toMatchObject({
      status: "cancelled",
      errorCode: "IMPORT_CANCELLED",
      terminalCount: 1,
      committed: null,
    });
    expect(observation.progress).toEqual(["preflight", "validating-archive"]);
  });

  test("persists the complete graph atomically and reads it after reopening IndexedDB", async ({ page }) => {
    const bytes = new Uint8Array(await readFile(fixturePath));
    await page.goto("");

    const observation = await page.evaluate(
      (fixture) => window.productionImportHarness.persist(new Uint8Array(fixture)),
      [...bytes],
    );

    expect(observation.status, JSON.stringify(observation)).toBe("success");
    expect(observation.errorCode).toBeNull();
    expect(observation.importId).toMatch(/^[0-9a-f]{64}$/);
    expect(observation.deckIds).toHaveLength(2);
    expect(observation.counts).toEqual({
      imports: 1,
      decks: 2,
      notes: 2,
      cards: 4,
      schedules: 4,
      media: 2,
    });
    expect(observation.allSchedulesFresh).toBe(true);
    expect(observation.mediaBytes).toBeGreaterThan(0);
  });
});
