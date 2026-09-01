export type DeckQueryState =
  | { kind: "missing"; value: null }
  | { kind: "empty"; value: "" }
  | { kind: "provided"; value: string };

type SearchParamsLike = Pick<URLSearchParams, "get">;

export function readDeckQuery(
  searchParams: SearchParamsLike,
): DeckQueryState {
  const value = searchParams.get("deck");

  if (value === null) {
    return { kind: "missing", value: null };
  }

  if (value === "") {
    return { kind: "empty", value: "" };
  }

  return { kind: "provided", value };
}
