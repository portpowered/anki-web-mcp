"use client";

import { useEffect, useRef, useState } from "react";

import {
  openStudyRouteService,
  type StudyMediaAsset,
} from "../../lib/application/study-route-service";
import { cn } from "../../lib/cn";

export type CardContentProps = {
  readonly html: string;
  readonly css?: string;
  readonly mediaRefs: readonly string[];
  readonly className?: string;
  readonly loadMedia?: (
    mediaRefs: readonly string[],
  ) => Promise<readonly StudyMediaAsset[]>;
};

const legacyDictionaryLabels = /大辞林\s*ウィズダム\s*類語辞典\s*EBPocket\s*jisho\s*weblio/giu;

export function cleanLegacyCardHtml(html: string): string {
  return html.replace(legacyDictionaryLabels, "");
}

export function scopeCardCss(css: string): string {
  return css.replace(/([^{}]+)\{/gu, (_block, selectors: string) => (
    `${selectors.split(",").map((selector) => (
      `[data-anki-card-template] ${selector.trim()}`
    )).join(",")}{`
  ));
}

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

export function attachMediaObjectUrls(
  html: string,
  urlsByReference: ReadonlyMap<string, string>,
): string {
  const withImages = attachImageObjectUrls(html, urlsByReference);
  let attachedSound = false;
  return withImages.replace(
    /<span\b[^>]*class="[^"]*\banki-sound\b[^"]*"[^>]*data-anki-media-ref="([^"]+)"[^>]*>[^<]*<\/span>/giu,
    (_sound, escapedReference: string) => {
      if (attachedSound) return "";
      const reference = decodeAttribute(escapedReference);
      const url = urlsByReference.get(reference);
      if (!url) return "";
      attachedSound = true;
      return `<audio autoplay data-anki-autoplay src="${escapeAttribute(url)}"></audio>`;
    },
  );
}

export function CardContent({
  html,
  css = "",
  mediaRefs,
  className,
  loadMedia = loadStudyMedia,
}: CardContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanHtml = cleanLegacyCardHtml(html);
  const [renderedHtml, setRenderedHtml] = useState(cleanHtml);

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    setRenderedHtml(cleanHtml);
    if (mediaRefs.length === 0) return () => undefined;

    void loadMedia(mediaRefs).then((assets) => {
      if (!active) return;
      const urls = new Map<string, string>();
      for (const asset of assets) {
        const url = URL.createObjectURL(asset.blob);
        objectUrls.push(url);
        urls.set(asset.ref, url);
      }
      setRenderedHtml(attachMediaObjectUrls(cleanHtml, urls));
    }).catch(() => {
      // Keep sanitized text and alt content visible if local media is missing.
    });

    return () => {
      active = false;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [cleanHtml, loadMedia, mediaRefs]);

  useEffect(() => {
    const audio = containerRef.current?.querySelector<HTMLAudioElement>("audio[data-anki-autoplay]");
    if (audio) void audio.play().catch(() => undefined);
  }, [renderedHtml]);

  return (
    <div className="h-full min-w-0 w-full max-w-full" data-anki-card-template>
      {css ? <style>{scopeCardCss(css)}</style> : null}
      <style>{`[data-anki-card-template] > [data-card-html]{box-sizing:border-box;height:100%!important;min-height:100%!important;width:100%!important;max-width:100%!important;margin:0!important}`}</style>
      <div
        className={cn(
          "card h-full min-h-full min-w-0 w-full max-w-full overflow-x-hidden [overflow-wrap:anywhere] [&_a]:hidden [&_audio]:hidden [&_img]:mx-auto [&_img]:max-h-64 [&_img]:max-w-full [&_img]:object-contain sm:[&_img]:max-h-72",
          className,
        )}
        data-card-html
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
        ref={containerRef}
      />
    </div>
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
