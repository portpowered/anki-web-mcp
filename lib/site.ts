export const defaultBasePath = "/anki-web-mcp";

export function assetPath(path: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? defaultBasePath;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (basePath === "") {
    return normalizedPath;
  }

  return `${basePath.replace(/\/$/, "")}${normalizedPath}`;
}
