export const webMcpOrigin = "https://portpowered.github.io";

export const webMcpOriginTrialToken =
  "Ahl1fT9auFnIx1go4r3W1lNMsfnOF6OTXFbnRS5s17ZkSlaVXWRge6WFriGgnxlON5SBpmqQBM7ALmbbIS7DvgwAAABoeyJvcmlnaW4iOiJodHRwczovL3BvcnRwb3dlcmVkLmdpdGh1Yi5pbzo0NDMiLCJmZWF0dXJlIjoiV2ViTUNQIiwiZXhwaXJ5IjoxNzk0ODczNjAwLCJpc1N1YmRvbWFpbiI6dHJ1ZX0=";

export type WebMcpCapability =
  | { kind: "available" }
  | { kind: "unavailable" }
  | { kind: "error" };

export type WebMcpDocument = {
  readonly modelContext?: unknown;
};

/**
 * Read the browser's native WebMCP surface without installing or mutating it.
 * A throwing browser getter is reported separately from an absent API so the
 * human diagnostic remains useful in both cases.
 */
export function detectWebMcpCapability(
  documentLike: object,
): WebMcpCapability {
  try {
    const modelContext = (documentLike as WebMcpDocument).modelContext;

    if (modelContext == null) {
      return { kind: "unavailable" };
    }

    return { kind: "available" };
  } catch {
    return { kind: "error" };
  }
}
