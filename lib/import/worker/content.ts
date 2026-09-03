import { FilterXSS, escapeAttrValue } from "xss";

import type {
  ImportWarning,
  NormalizedCard,
  NormalizedCardContent,
  NormalizedImportGraph,
  NormalizedNote,
} from "../contracts";
import { importError, type ImportError } from "../errors";

export interface ContentCompilationControl {
  readonly operationId: string;
  readonly isCancelled?: () => boolean;
  readonly checkpoint?: () => void;
}

export interface CompiledContentResult {
  readonly graph: NormalizedImportGraph;
  readonly warnings: readonly ImportWarning[];
}

export class ContentCompilationFailure extends Error {
  public constructor(public readonly error: ImportError) {
    super(error.message);
    this.name = "ContentCompilationFailure";
  }
}

const allowedTags: Record<string, string[]> = {
  a: ["class"], b: [], blockquote: [], br: [], code: [], div: ["class", "style"], em: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], hr: ["id"], i: [],
  img: ["alt", "class", "data-anki-media-ref", "height", "style", "title", "width"],
  li: [], ol: [], p: ["class", "style"], pre: [], s: [], small: [], span: ["class", "data-anki-media-ref", "style"],
  rp: [], rt: [], ruby: [], section: ["class", "style"], strong: [], sub: [], sup: [], table: [], tbody: [], td: [], th: [], thead: [], tr: [], u: [], ul: [],
};

const allowedCssProperties = new Set([
  "background-color", "border", "border-color", "border-radius", "border-style", "border-width",
  "color", "display", "font-family", "font-size", "font-style", "font-weight", "height",
  "letter-spacing", "line-height", "margin", "margin-bottom", "margin-left", "margin-right", "margin-top",
  "max-height", "max-width", "min-height", "min-width", "opacity", "padding", "padding-bottom",
  "padding-left", "padding-right", "padding-top", "text-align", "text-decoration", "text-transform",
  "vertical-align", "white-space", "width", "word-break", "word-spacing", "overflow", "overflow-wrap",
]);

const activeBodyTags = ["script", "style", "iframe", "object", "embed", "svg", "math", "form", "template"];

/** Compile every normalized card without evaluating imported template content. */
export function compileImportContent(
  graph: NormalizedImportGraph,
  control: ContentCompilationControl,
): CompiledContentResult {
  const notes = new Map(graph.notes.map((note) => [note.id, note]));
  const notetypes = new Map(graph.notetypes.map((notetype) => [notetype.id, notetype]));
  const templates = new Map(graph.cardTemplates.map((template) => [
    `${template.notetypeId}:${template.ordinal}`,
    template,
  ]));
  const warnings: ImportWarning[] = [];
  const warningKeys = new Set<string>();

  const cards = graph.cards.map((card) => {
    checkpoint(control);
    const note = notes.get(card.noteId);
    const notetype = note && notetypes.get(note.notetypeId);
    const template = note && templates.get(`${note.notetypeId}:${card.templateOrdinal}`);
    if (!note || !notetype || !template) throw compilationFailure(control.operationId, `card:${card.id}`);
    const values = new Map(notetype.fields.map((name, index) => [name, note.fields[index] ?? ""]));
    const context: RenderContext = {
      operationId: control.operationId,
      card,
      note,
      templateId: `${template.notetypeId}:${template.ordinal}`,
      values,
      warning(code, message, kind = "card") {
        const source = kind === "model"
          ? { kind, id: note.notetypeId } as const
          : kind === "template"
            ? { kind, id: `${template.notetypeId}:${template.ordinal}` } as const
            : { kind, id: card.id } as const;
        const key = `${code}:${source.kind}:${source.id}:${message}`;
        if (!warningKeys.has(key)) {
          warningKeys.add(key);
          warnings.push({ code, message, stage: "compiling-content", source });
        }
      },
    };
    const front = compileSide(template.questionFormat, "front", context);
    const back = compileSide(template.answerFormat, "back", context, front.html);
    const css = sanitizeStylesheet(notetype.css);
    if (css.removed) context.warning("UNSAFE_CONTENT_REMOVED", "Unsafe model CSS was removed.", "model");
    const mediaReferences = [...new Set([...front.media, ...back.media])].sort(compareCanonical);
    const content: NormalizedCardContent = Object.freeze({
      frontText: htmlToText(front.html),
      backText: htmlToText(back.html),
      frontHtml: front.html,
      backHtml: back.html,
      css: css.value,
      mediaReferences: Object.freeze(mediaReferences),
    });
    return Object.freeze({ ...card, content });
  });

  return {
    graph: Object.freeze({ ...graph, cards: Object.freeze(cards) }),
    warnings: Object.freeze(warnings),
  };
}

interface RenderContext {
  readonly operationId: string;
  readonly card: Omit<NormalizedCard, "content"> | NormalizedCard;
  readonly note: NormalizedNote;
  readonly templateId: string;
  readonly values: ReadonlyMap<string, string>;
  warning(
    code: "UNSAFE_CONTENT_REMOVED" | "UNSUPPORTED_TEMPLATE_FEATURE",
    message: string,
    kind?: "card" | "template" | "model",
  ): void;
}

interface CompiledSide {
  readonly html: string;
  readonly media: readonly string[];
}

function compileSide(
  format: string,
  side: "front" | "back",
  context: RenderContext,
  frontHtml = "",
): CompiledSide {
  if (format.length > 2_000_000 || hasUnbalancedTemplateSyntax(format)) {
    throw compilationFailure(context.operationId, `template:${context.templateId}`);
  }
  let rendered = renderConditionals(format, context);
  rendered = rendered.replace(/\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawName, normalName) => {
    const directive = String(rawName ?? normalName).trim();
    if (directive === "FrontSide") return side === "back" ? frontHtml : "";
    if (directive.startsWith("cloze:")) {
      const value = context.values.get(directive.slice(6).trim());
      return value === undefined ? unsupportedDirective(directive, context) : renderCloze(value, side, context.card.templateOrdinal);
    }
    if (directive.startsWith("text:")) {
      const value = context.values.get(directive.slice(5).trim());
      return value === undefined ? unsupportedDirective(directive, context) : escapeHtml(htmlToText(value));
    }
    if (directive.startsWith("furigana:")) {
      const value = context.values.get(directive.slice(9).trim());
      return value === undefined ? unsupportedDirective(directive, context) : renderFurigana(value);
    }
    if (directive.startsWith("&")) {
      const value = context.values.get(directive.slice(1).trim());
      return value === undefined ? unsupportedDirective(directive, context) : value;
    }
    const value = context.values.get(directive);
    if (value !== undefined) return value;
    return unsupportedDirective(directive, context);
  });
  rendered = rendered.replace(/\[sound:([^\]\r\n]+)\]/gi, (_match, name) => {
    const normalized = normalizeMediaName(String(name));
    if (!normalized) {
      context.warning("UNSAFE_CONTENT_REMOVED", "An unsafe sound reference was removed.");
      return "";
    }
    return `<span class="anki-sound" data-anki-media-ref="${escapeAttrValue(normalized)}"></span>`;
  });
  const sanitized = sanitizeHtml(rendered);
  if (sanitized.removed) context.warning(
    "UNSAFE_CONTENT_REMOVED",
    "Unsafe imported card content was removed.",
    "template",
  );
  return { html: sanitized.value, media: sanitized.media };
}

/** Render Anki's `base[reading]` furigana notation without executing HTML. */
function renderFurigana(value: string): string {
  return value.replace(
    /(^|[\s>])([^\s<>\[\]]+)\[([^\]\r\n]+)\]/gu,
    (_match, prefix, base, reading) => (
      `${prefix}<ruby>${base}<rp>(</rp><rt>${reading}</rt><rp>)</rp></ruby>`
    ),
  );
}

function renderConditionals(format: string, context: RenderContext): string {
  let output = format;
  const section = /\{\{\s*([#^])\s*([^{}]+?)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\2\s*\}\}/g;
  for (let pass = 0; pass < 20; pass += 1) {
    let changed = false;
    output = output.replace(section, (_match, kind, name, body) => {
      changed = true;
      const value = context.values.get(String(name).trim());
      if (value === undefined) return unsupportedDirective(`${kind}${String(name).trim()}`, context);
      const populated = htmlToText(value).trim().length > 0;
      return (kind === "#" ? populated : !populated) ? String(body) : "";
    });
    if (!changed) break;
  }
  return output;
}

function renderCloze(value: string, side: "front" | "back", ordinal: number): string {
  return value.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/gi, (_match, number, answer, hint) => {
    if (side === "back" || Number(number) !== ordinal + 1) return `<span class="cloze">${answer}</span>`;
    return `<span class="cloze">[${hint ? escapeHtml(String(hint)) : "..."}]</span>`;
  });
}

function unsupportedDirective(directive: string, context: RenderContext): string {
  context.warning(
    "UNSUPPORTED_TEMPLATE_FEATURE",
    `Unsupported template directive: ${directive.slice(0, 80)}`,
    "template",
  );
  return "";
}

function sanitizeHtml(html: string): { value: string; removed: boolean; media: readonly string[] } {
  let removed = false;
  const media = new Set<string>();
  const filter = new FilterXSS({
    allowList: allowedTags,
    stripIgnoreTagBody: activeBodyTags,
    css: false,
    onIgnoreTag: () => { removed = true; return ""; },
    onIgnoreTagAttr(tag, name, value) {
      if (tag === "img" && name.toLowerCase() === "src") {
        const normalized = normalizeMediaName(value);
        if (normalized) {
          media.add(normalized);
          return `data-anki-media-ref="${escapeAttrValue(normalized)}"`;
        }
      }
      removed = true;
      return "";
    },
    safeAttrValue(tag, name, value) {
      if (name === "style") {
        const style = sanitizeDeclarations(value);
        if (style.removed) removed = true;
        return escapeAttrValue(style.value);
      }
      if (name === "data-anki-media-ref") {
        const normalized = normalizeMediaName(value);
        if (!normalized) { removed = true; return ""; }
        media.add(normalized);
        return escapeAttrValue(normalized);
      }
      if (name === "class" && !/^[\w -]{0,120}$/u.test(value)) { removed = true; return ""; }
      return escapeAttrValue(value.slice(0, 500));
    },
  });
  return { value: filter.process(html), removed, media: [...media].sort(compareCanonical) };
}

function sanitizeStylesheet(css: string): { value: string; removed: boolean } {
  let removed = false;
  let value = "";
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (withoutComments !== css) removed = true;
  const block = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  let consumed = "";
  while ((match = block.exec(withoutComments)) !== null) {
    consumed += match[0];
    const selector = match[1].trim();
    if (!isSafeSelector(selector)) { removed = true; continue; }
    const declarations = sanitizeDeclarations(match[2]);
    if (declarations.removed) removed = true;
    if (declarations.value) value += `${selector}{${declarations.value}}`;
  }
  if (withoutComments.replace(block, "").trim() !== "" || consumed.length === 0 && withoutComments.trim() !== "") removed = true;
  return { value, removed };
}

function sanitizeDeclarations(input: string): { value: string; removed: boolean } {
  let removed = false;
  const declarations: string[] = [];
  for (const raw of input.split(";")) {
    const declaration = raw.trim();
    if (!declaration) continue;
    const separator = declaration.indexOf(":");
    if (separator <= 0) { removed = true; continue; }
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!allowedCssProperties.has(property) || !isSafeCssValue(value)) { removed = true; continue; }
    declarations.push(`${property}:${value}`);
  }
  return { value: declarations.join(";"), removed };
}

function isSafeSelector(selector: string): boolean {
  return selector.length <= 300
    && !selector.includes("@")
    && !/[\[\]=]/.test(selector)
    && /^[\w\s.,#>:*+~()-]+$/u.test(selector);
}

function isSafeCssValue(value: string): boolean {
  return value.length <= 500
    && !/[{}<>\\]/.test(value)
    && !/(?:url|expression|image-set|javascript|data|@import|behavior|-moz-binding)\s*\(/iu.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeMediaName(value: string): string | null {
  const decoded = decodeHtmlEntities(value).trim().normalize("NFC").replaceAll("\\", "/");
  if (!decoded || decoded.length > 240 || decoded.startsWith("/") || decoded.startsWith("//")) return null;
  if (/^[a-z][a-z\d+.-]*:/iu.test(decoded) || /[?#\u0000-\u001f\u007f]/u.test(decoded)) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function hasUnbalancedTemplateSyntax(value: string): boolean {
  const openings = (value.match(/\{\{/g) ?? []).length;
  const closings = (value.match(/\}\}/g) ?? []).length;
  return openings !== closings;
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<(?:br|\/p|\/div|\/li|hr)\b[^>]*>/giu, "\n")
    .replace(/<[^>]*>/g, ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: "\u00a0", quot: '"' };
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));?/giu, (entity, decimal, hex, name) => {
    const point = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : undefined;
    if (point !== undefined) {
      try { return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity; }
      catch { return entity; }
    }
    return named[String(name).toLowerCase()] ?? entity;
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function checkpoint(control: ContentCompilationControl): void {
  control.checkpoint?.();
  if (control.isCancelled?.()) {
    throw new ContentCompilationFailure(importError("IMPORT_CANCELLED", {
      operationId: control.operationId,
      stage: "compiling-content",
    }));
  }
}

function compilationFailure(operationId: string, detail: string): ContentCompilationFailure {
  return new ContentCompilationFailure(importError("TEMPLATE_COMPILATION_FAILED", {
    operationId,
    stage: "compiling-content",
    detail,
  }));
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
