/**
 * Draw a rendered page into a PNG without a native capture.
 *
 * The desktop app captures its hidden print window with `capturePage`; a
 * browser has nothing like it. What a browser can do is draw an SVG image,
 * and an SVG may hold arbitrary HTML in a `foreignObject`. So the page is
 * copied into one, self-contained: an SVG used as an image loads nothing from
 * the network, so every stylesheet, font and picture it needs is inlined as a
 * data URL first. What cannot be pictured that way is left out and counted:
 * plugin content (a PDF placed as an image) and embedded web pages.
 */

/** A page drawn as a PNG, and how many objects in it could not be drawn. */
export interface RasterizedPage {
  blob: Blob;
  skipped: number;
}

type DataUrlFetcher = (url: string) => Promise<string | null>;

const URL_PATTERN = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]*))\s*\)/g;

/**
 * Replace every `url(...)` in `css` with what `replace` returns for its
 * absolute form; `null` keeps the original. Data URLs and fragment-only
 * references (an SVG filter's `url(#id)`) are left alone.
 */
export async function replaceCssUrls(
  css: string,
  base: string,
  replace: (absolute: string) => Promise<string | null>,
): Promise<string> {
  const found = new Map<string, Promise<string | null>>();
  for (const match of css.matchAll(URL_PATTERN)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    if (!raw || raw.startsWith('data:') || raw.startsWith('#') || found.has(raw)) continue;
    let absolute: string;
    try {
      absolute = new URL(raw.replace(/\\(.)/g, '$1'), base).href;
    } catch {
      continue;
    }
    found.set(raw, replace(absolute));
  }
  if (found.size === 0) return css;
  const resolved = new Map<string, string | null>();
  await Promise.all([...found].map(async ([raw, pending]) => {
    resolved.set(raw, await pending);
  }));
  return css.replace(URL_PATTERN, (whole, double, single, bare) => {
    const replacement = resolved.get(double ?? single ?? bare ?? '');
    return replacement ? `url("${replacement}")` : whole;
  });
}

/** Split a comma-separated CSS list, ignoring commas inside parentheses or quotes. */
export function splitCssList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === '\'') {
      quote = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * The one source of an `@font-face` `src` list worth inlining: the first
 * WOFF2, else the first downloadable one. Inlining every fallback format
 * (KaTeX lists three per face) would triple the picture's size for nothing.
 * `local()` sources are dropped: the picture must not depend on them.
 */
export function preferredFontSource(src: string): string | null {
  const sources = splitCssList(src).filter((source) => /^url\(/i.test(source));
  return sources.find((source) => /format\(\s*["']?woff2["']?\s*\)/i.test(source))
    ?? sources[0]
    ?? null;
}

/** A font family name as `@font-face` and `FontFace.family` both spell it. */
export function normalizeFontFamily(family: string): string {
  return family.trim().replace(/^(["'])(.*)\1$/, '$2').toLowerCase();
}

function normalizeRange(range: string): string {
  return range.replace(/\s+/g, '').toLowerCase();
}

/**
 * Which `@font-face` rules the page actually used: its loaded faces, keyed by
 * family, each with the unicode ranges that loaded. A rule for a family the
 * page never drew with is not worth the bytes; nor is a Google Fonts subset
 * (one rule per script) that no character on the page fell into.
 */
export function loadedFontFaces(fonts: Iterable<FontFace> | undefined): Map<string, Set<string>> {
  const faces = new Map<string, Set<string>>();
  for (const face of fonts ?? []) {
    if (face.status !== 'loaded') continue;
    const family = normalizeFontFamily(face.family);
    const ranges = faces.get(family) ?? new Set<string>();
    if (face.unicodeRange) ranges.add(normalizeRange(face.unicodeRange));
    faces.set(family, ranges);
  }
  return faces;
}

/** Whether a `@font-face` with these descriptors was one the page used. */
export function fontFaceUsed(
  family: string,
  unicodeRange: string,
  loaded: Map<string, Set<string>>,
): boolean {
  const ranges = loaded.get(normalizeFontFamily(family));
  if (!ranges) return false;
  if (!unicodeRange || ranges.size === 0) return true;
  return ranges.has(normalizeRange(unicodeRange));
}

/** `@font-face` text holding only the source worth inlining, or null to drop the rule. */
function fontFaceText(rule: CSSFontFaceRule, loaded: Map<string, Set<string>>): string | null {
  const style = rule.style;
  const family = style.getPropertyValue('font-family');
  if (!fontFaceUsed(family, style.getPropertyValue('unicode-range'), loaded)) return null;
  const source = preferredFontSource(style.getPropertyValue('src'));
  if (!source) return null;
  const descriptors: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style[i];
    if (name !== 'src') descriptors.push(`${name}: ${style.getPropertyValue(name)};`);
  }

  return `@font-face { ${descriptors.join(' ')} src: ${source}; }`;
}

/** The text of `rules`, `@import`s followed and unused fonts dropped. */
async function rulesText(
  rules: CSSRuleList,
  base: string,
  loaded: Map<string, Set<string>>,
  fetchDataUrl: DataUrlFetcher,
): Promise<string> {
  const parts: string[] = [];
  for (const rule of [...rules]) {
    if (rule.cssText.startsWith('@import')) {
      const imported = (rule as CSSImportRule).styleSheet;
      if (imported) parts.push(await sheetText(imported, loaded, fetchDataUrl));
    } else if (rule.cssText.startsWith('@font-face')) {
      const text = fontFaceText(rule as CSSFontFaceRule, loaded);
      if (text) parts.push(text);
    } else {
      parts.push(rule.cssText);
    }
  }

  return replaceCssUrls(parts.join('\n'), base, fetchDataUrl);
}

/**
 * One stylesheet's rules as self-contained text. A cross-origin sheet (a
 * theme's Google Fonts `@import`) hides its rules from script, so it is
 * fetched again with CORS, which font services allow, and parsed here.
 */
async function sheetText(
  sheet: CSSStyleSheet,
  loaded: Map<string, Set<string>>,
  fetchDataUrl: DataUrlFetcher,
): Promise<string> {
  const base = sheet.href ?? sheet.ownerNode?.baseURI ?? document.baseURI;
  let rules: CSSRuleList | null = null;
  try {
    rules = sheet.cssRules;
  } catch {
    rules = null;
  }

  if (rules) return rulesText(rules, base, loaded, fetchDataUrl);
  if (!sheet.href) return '';
  try {
    const response = await fetch(sheet.href);
    if (!response.ok) return '';
    const parsed = new CSSStyleSheet();
    parsed.replaceSync(await response.text());
    return rulesText(parsed.cssRules, sheet.href, loaded, fetchDataUrl);
  } catch {
    return '';
  }
}

/** Every stylesheet of `doc`, in cascade order, as one self-contained text. */
export async function documentCss(doc: Document, fetchDataUrl: DataUrlFetcher): Promise<string> {
  const loaded = loadedFontFaces(doc.fonts as Iterable<FontFace> | undefined);
  const texts: string[] = [];
  for (const sheet of [...doc.styleSheets]) {
    if (sheet.disabled) continue;
    texts.push(await sheetText(sheet, loaded, fetchDataUrl));
  }

  return texts.join('\n');
}

/** Fetch `url` as a data URL; null when it cannot be read. Cached per picture. */
export function dataUrlFetcher(): DataUrlFetcher {
  const cache = new Map<string, Promise<string | null>>();
  return (url) => {
    let pending = cache.get(url);
    if (!pending) {
      pending = (async () => {
        try {
          const response = await fetch(url);
          if (!response.ok) return null;
          return await blobToDataUrl(await response.blob());
        } catch {
          return null;
        }
      })();
      cache.set(url, pending);
    }

    return pending;
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(blob);
  });
}

/** Elements whose content is drawn by a plugin or another document: no picture can hold them. */
const UNDRAWABLE = new Set(['EMBED', 'OBJECT', 'IFRAME']);

/** Elements that only matter to the live page. */
const DROPPED = new Set(['SCRIPT', 'NOSCRIPT', 'LINK', 'STYLE', 'TEMPLATE']);

interface CloneState {
  skipped: number;
  /** Shadow-root CSS, scoped to its host with `@scope`. */
  scopedCss: string[];
  /** Work that inlines a resource into the copy, awaited before drawing. */
  pending: Array<Promise<void>>;
  fetchDataUrl: DataUrlFetcher;
}

/** A still image standing in for `source` (a canvas or a video's poster), styled like it. */
function stillImage(source: HTMLElement, src: string): HTMLImageElement {
  const image = source.ownerDocument.createElement('img');
  for (const attribute of [...source.attributes]) {
    if (['class', 'style', 'width', 'height'].includes(attribute.name)) {
      image.setAttribute(attribute.name, attribute.value);
    }
  }

  image.src = src;
  return image;
}

function inlineAttribute(element: Element, name: string, state: CloneState): void {
  const value = element.getAttribute(name);
  if (!value || value.startsWith('data:')) return;
  const absolute = new URL(value, element.baseURI).href;
  state.pending.push(state.fetchDataUrl(absolute).then((data) => {
    if (data) element.setAttribute(name, data);
  }));
}

function inlineStyleAttribute(element: Element, state: CloneState): void {
  const style = element.getAttribute('style');
  if (!style || !style.includes('url(')) return;
  state.pending.push(replaceCssUrls(style, element.baseURI, state.fetchDataUrl).then((inlined) => {
    element.setAttribute('style', inlined);
  }));
}

/**
 * Copy `node` for the picture: stills for canvases and videos, inlined
 * pictures, shadow content flattened into the light tree, undrawable
 * content dropped and counted.
 */
function cloneForPicture(node: Node, state: CloneState): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  if (DROPPED.has(tag)) return null;
  if (UNDRAWABLE.has(tag)) {
    state.skipped++;
    return null;
  }

  if (tag === 'CANVAS') {
    try {
      return stillImage(element as HTMLElement, (element as HTMLCanvasElement).toDataURL('image/png'));
    } catch {
      state.skipped++;
      return null;
    }
  }

  if (tag === 'VIDEO') {
    // readiness.ts has already frozen every video it could into a canvas.
    const video = element as HTMLVideoElement;
    if (!video.poster) {
      state.skipped++;
      return null;
    }

    const still = stillImage(video, video.poster);
    inlineAttribute(still, 'src', state);
    return still;
  }

  const copy = element.cloneNode(false) as Element;
  inlineStyleAttribute(copy, state);
  if (tag === 'IMG') {
    const image = element as HTMLImageElement;
    copy.removeAttribute('srcset');
    copy.removeAttribute('loading');
    copy.setAttribute('src', image.currentSrc || image.src);
    inlineAttribute(copy, 'src', state);
  } else if (tag === 'IMAGE') {
    inlineAttribute(copy, copy.hasAttribute('href') ? 'href' : 'xlink:href', state);
  }

  let children: NodeListOf<ChildNode> | ChildNode[] = element.childNodes;
  const shadow = element.shadowRoot;
  if (shadow) {
    // The picture has no shadow DOM: the shadow tree becomes ordinary
    // children, and its stylesheet applies only below the host via @scope.
    const scope = `${state.scopedCss.length}`;
    copy.setAttribute('data-picture-scope', scope);
    const css = [...shadow.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
    const scoped = `@scope ([data-picture-scope="${scope}"]) {\n${css.replace(/:host\b/g, ':scope')}\n}`;
    state.scopedCss.push(scoped);
    children = [...shadow.childNodes];
  }

  for (const child of children) {
    const cloned = cloneForPicture(child, state);
    if (cloned) copy.appendChild(cloned);
  }

  return copy;
}

/** An SVG document showing `xhtml` (one serialized `<html>`) at `width` × `height`. */
export function pictureSvg(xhtml: string, width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
}

/**
 * Serialize `doc` as a self-contained SVG of its top-left `width` × `height`.
 */
export async function snapshotDocument(
  doc: Document,
  width: number,
  height: number,
): Promise<{ svg: string; skipped: number }> {
  const fetchDataUrl = dataUrlFetcher();
  const state: CloneState = { skipped: 0, scopedCss: [], pending: [], fetchDataUrl };
  const root = doc.documentElement;
  const copy = cloneForPicture(root, state) as HTMLElement;
  const css = await documentCss(doc, fetchDataUrl);
  const scoped = await Promise.all(state.scopedCss.map((text) => replaceCssUrls(text, doc.baseURI, fetchDataUrl)));
  await Promise.all(state.pending);

  let head = copy.querySelector('head');
  if (!head) {
    head = doc.createElement('head');
    copy.prepend(head);
  }

  const style = doc.createElement('style');
  style.textContent = [css, ...scoped].join('\n');
  head.appendChild(style);
  copy.style.width = `${width}px`;
  copy.style.height = `${height}px`;
  copy.style.overflow = 'hidden';
  const xhtml = new XMLSerializer().serializeToString(copy);
  return { svg: pictureSvg(xhtml, width, height), skipped: state.skipped };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The browser could not draw the picture'));
    image.src = src;
  });
}

/**
 * Draw the top-left `width` × `height` of `doc` as a PNG with transparency.
 *
 * Raises if the browser refuses: Safari, for one, may treat a canvas holding
 * a `foreignObject` as tainted and refuse to export it.
 */
export async function rasterizeDocument(doc: Document, width: number, height: number): Promise<RasterizedPage> {
  const { svg, skipped } = await snapshotDocument(doc, width, height);
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  // An SVG image decodes its inlined fonts on its own clock; drawing before
  // they are ready falls back to a system face for that one draw.
  await image.decode().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser has no canvas to draw the picture on');
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    try {
      canvas.toBlob(resolve, 'image/png');
    } catch (err) {
      reject(err instanceof Error && err.name === 'SecurityError'
        ? new Error('This browser does not allow the picture to be copied')
        : err);
    }
  });
  if (!blob) throw new Error('The picture came out empty');
  return { blob, skipped };
}
