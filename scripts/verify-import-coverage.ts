import { readFile } from "node:fs/promises";

const REQUIRED_FILES = [
  "lib/import/limits.ts",
  "lib/import/worker/archive.ts",
] as const;

interface CoverageRecord {
  source: string;
  functionsFound: number;
  functionsHit: number;
  linesFound: number;
  linesHit: number;
}

const lcov = await readFile("coverage/lcov.info", "utf8");
const records = lcov
  .split("end_of_record")
  .map(parseRecord)
  .filter((record): record is CoverageRecord => record !== null);

for (const requiredFile of REQUIRED_FILES) {
  const record = records.find(({ source }) => source === requiredFile);
  if (!record) {
    throw new Error(`Coverage did not report required import safety file: ${requiredFile}`);
  }
  if (
    record.functionsFound === 0
    || record.linesFound === 0
    || record.functionsHit !== record.functionsFound
    || record.linesHit !== record.linesFound
  ) {
    throw new Error(
      `${requiredFile} coverage is functions ${record.functionsHit}/${record.functionsFound}, `
      + `lines ${record.linesHit}/${record.linesFound}; both must remain 100%.`,
    );
  }
}

console.log("Import limit and archive safety coverage is 100% for functions and lines.");

function parseRecord(block: string): CoverageRecord | null {
  const fields = new Map(
    block
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const separator = line.indexOf(":");
        return separator < 0
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const source = fields.get("SF")?.replaceAll("\\", "/");
  if (!source) return null;
  return {
    source,
    functionsFound: count(fields, "FNF"),
    functionsHit: count(fields, "FNH"),
    linesFound: count(fields, "LF"),
    linesHit: count(fields, "LH"),
  };
}

function count(fields: ReadonlyMap<string, string>, name: string): number {
  const value = Number(fields.get(name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Coverage report has an invalid ${name} value.`);
  }
  return value;
}
