import { expect, test } from "@playwright/test";

import { acquireDurableStudySnapshot } from "../../scripts/webmcp-study-observation";

test("ordinary study snapshot reads media bytes without retaining its transaction", async ({ page }) => {
  await page.goto("");
  const databaseName = `study-snapshot-${Date.now()}`;
  await page.evaluate(async (name) => {
    const request = <T>(operation: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error);
      });
    const opened = indexedDB.open(name, 1);
    opened.onupgradeneeded = () => {
      for (const storeName of ["cards", "media", "reviewLogs", "schedules", "sessions"]) {
        opened.result.createObjectStore(storeName);
      }
    };
    const database = await request(opened);
    const transaction = database.transaction([...database.objectStoreNames], "readwrite");
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    transaction.objectStore("sessions").put(
      { id: "session-1", deckId: "deck-1", activeCardId: "card-1", completedAt: null },
      "session-1",
    );
    transaction.objectStore("cards").put(
      { id: "card-1", deckId: "deck-1", answerHtml: "Back" },
      "card-1",
    );
    transaction.objectStore("schedules").put(
      { cardId: "card-1", deckId: "deck-1", dueAt: 123 },
      "card-1",
    );
    transaction.objectStore("reviewLogs").put(
      { id: "review-1", deckId: "deck-1", cardId: "card-1" },
      "review-1",
    );
    transaction.objectStore("media").put(
      {
        id: "media-1",
        sha256: "persisted-metadata-is-not-content-identity",
        blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/octet-stream" }),
      },
      "media-1",
    );
    await completed;
    database.close();
  }, databaseName);

  try {
    const snapshot = await page.evaluate(acquireDurableStudySnapshot, {
      selectedDeckId: "deck-1",
      databaseName,
    });

    expect(snapshot.session).toMatchObject({ id: "session-1", activeCardId: "card-1" });
    expect(snapshot.card).toMatchObject({ id: "card-1", answerHtml: "Back" });
    expect(snapshot.schedule).toMatchObject({ cardId: "card-1", dueAt: 123 });
    expect(snapshot.schedules).toHaveLength(1);
    expect(snapshot.reviewLogs).toHaveLength(1);
    expect(snapshot.stores.media).toEqual([
      {
        id: "media-1",
        sha256: "persisted-metadata-is-not-content-identity",
        blob: {
          size: 4,
          type: "application/octet-stream",
          bytesSha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
        },
      },
    ]);
  } finally {
    await page.evaluate((name) => new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase(name);
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
      deletion.onblocked = () => reject(new Error("snapshot test database deletion blocked"));
    }), databaseName);
  }
});
