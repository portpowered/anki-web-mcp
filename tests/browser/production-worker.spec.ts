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

  test("cancellation at every Worker stage terminates without commit readiness", async ({ page }) => {
    const bytes = new Uint8Array(await readFile(fixturePath));
    await page.goto("");

    for (const stage of [
      "validating-archive",
      "decompressing-collection",
      "parsing-records",
      "compiling-content",
      "importing-media",
    ] as const) {
      const observation = await page.evaluate(
        ({ fixture, stage }) => window.productionImportHarness.run(
          new Uint8Array(fixture),
          stage,
        ),
        { fixture: [...bytes], stage },
      );

      expect(observation, stage).toMatchObject({
        status: "cancelled",
        errorCode: "IMPORT_CANCELLED",
        terminalCount: 1,
        committed: null,
      });
      expect(observation.progress.at(-1), stage).toBe(stage);
    }
  });

  test("hostile packages fail through the production service without a commit", async ({ page }) => {
    const cases = [
      ["invalid-sqlite.apkg", "SQLITE_INVALID"],
      ["invalid-zstd.apkg", "ZSTD_INVALID"],
      ["invalid-protobuf-media.apkg", "MEDIA_MAP_INVALID"],
      ["traversal-archive-path.apkg", "ARCHIVE_PATH_UNSAFE"],
      ["disallowed-media-mime.apkg", "MIME_NOT_ALLOWED"],
      ["unknown-layout.apkg", "UNSUPPORTED_PACKAGE"],
    ] as const;
    await page.goto("");

    for (const [file, errorCode] of cases) {
      const bytes = new Uint8Array(await readFile(resolve(
        "spikes",
        "apkg-compatibility",
        "fixtures",
        "synthetic",
        file,
      )));
      const observation = await page.evaluate(
        (fixture) => window.productionImportHarness.run(new Uint8Array(fixture)),
        [...bytes],
      );
      expect(observation, file).toMatchObject({
        status: "failed",
        errorCode,
        terminalCount: 1,
        committed: null,
      });
    }
  });

  test("a superseded real Worker cannot commit after its replacement starts", async ({ page }) => {
    const bytes = new Uint8Array(await readFile(fixturePath));
    await page.goto("");

    const observation = await page.evaluate(
      (fixture) => window.productionImportHarness.supersede(new Uint8Array(fixture)),
      [...bytes],
    );

    expect(observation).toMatchObject({
      oldStatus: "cancelled",
      replacementStatus: "success",
      oldTerminalCount: 1,
      replacementTerminalCount: 1,
    });
    expect(observation.committedOperationIds).toHaveLength(1);
    expect(observation.committedOperationIds[0]).toMatch(/^browser-replacement-/);
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
