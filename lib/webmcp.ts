export const webMcpOrigin = "https://portpowered.github.io";

export const webMcpOriginTrialToken =
  "A/MXFu/smsk8zDkOidDtDxnHQbr502frxTfbhB94iRy6Tc8m6BzqVCh3DibOCvEGdPiGm4+ww+AZkNN77vNnTgkAAABpeyJvcmlnaW4iOiJodHRwczovL3BvcnRwb3dlcmVkLmdpdGh1Yi5pbzo0NDMiLCJmZWF0dXJlIjoiV2ViTUNQIiwiZXhwaXJ5IjoxNzk0ODczNjAwLCJpc1RoaXJkUGFydHkiOnRydWV9";

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
