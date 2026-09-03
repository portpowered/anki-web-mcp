"use client";

import { useEffect, useState } from "react";

import {
  openStudyRouteService,
  type StudyMediaAsset,
} from "../../lib/application/study-route-service";
import { cn } from "../../lib/cn";

export type CardContentProps = {
  readonly html: string;
  readonly mediaRefs: readonly string[];
  readonly className?: string;
  readonly loadMedia?: (
    mediaRefs: readonly string[],
  ) => Promise<readonly StudyMediaAsset[]>;
};

async function loadStudyMedia(
  mediaRefs: readonly string[],
): Promise<readonly StudyMediaAsset[]> {
  const service = await openStudyRouteService();
  return service.loadMedia(mediaRefs);
}

/**
 * Adds browser-owned object URLs only to inert image nodes emitted by the APKG
 * sanitizer. No package-authored URL is ever trusted or copied into `src`.
 */
export function attachImageObjectUrls(
  html: string,
  urlsByReference: ReadonlyMap<string, string>,
): string {
  return html.replace(
    /<img\b[^>]*\bdata-anki-media-ref="([^"]+)"[^>]*>/giu,
    (image, escapedReference: string) => {
      const reference = decodeAttribute(escapedReference);
      const url = urlsByReference.get(reference);
      if (!url || /\bsrc\s*=/iu.test(image)) return image;
      return image.replace(/\s*\/?>$/u, (ending: string) => (
        ` src="${escapeAttribute(url)}"${ending.trimStart()}`
      ));
    },
  );
}

export function CardContent({
  html,
  mediaRefs,
  className,
  loadMedia = loadStudyMedia,
}: CardContentProps) {
  const [renderedHtml, setRenderedHtml] = useState(html);

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    setRenderedHtml(html);
    if (mediaRefs.length === 0) return () => undefined;

    void loadMedia(mediaRefs).then((assets) => {
      if (!active) return;
      const urls = new Map<string, string>();
      for (const asset of assets) {
        const url = URL.createObjectURL(asset.blob);
        objectUrls.push(url);
        urls.set(asset.ref, url);
      }
      setRenderedHtml(attachImageObjectUrls(html, urls));
    }).catch(() => {
      // Keep sanitized text and alt content visible if local media is missing.
    });

    return () => {
      active = false;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [html, loadMedia, mediaRefs]);

  return (
    <div
      className={cn(
        "[&_img]:mx-auto [&_img]:max-h-48 [&_img]:max-w-full [&_img]:object-contain",
        className,
      )}
      data-card-html
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}

function decodeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
