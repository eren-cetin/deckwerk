import {
  copyImageScale,
  selectionBounds,
  type CopyImageJob,
  type CopyImageRequest,
  type CopyImageResult,
} from '@shared/copyImage.js';
import type { RenderCopyImage } from './copyImagePage.js';
import type { RasterizedPage } from './rasterize.js';

/**
 * Copy as Image in the browser: the collab client's `writeClipboardImage`.
 *
 * The selection is laid out by the desktop app's own image page (in a frame
 * of this tab, copyImage.html), drawn to a PNG, and written with the async
 * Clipboard API. Safari only honours a clipboard write started inside the
 * key or click that asked for it, so the write is issued at once with the
 * PNG as a promise, and the drawing finishes behind it.
 */

/** Longest the frame may take to load, settle and draw, as on the desktop. */
const RENDER_TIMEOUT_MS = 30_000;

/** Whether this page may put a PNG on the clipboard: https or localhost, and a browser that can. */
export function canWriteClipboardImage(): boolean {
  return window.isSecureContext
    && typeof ClipboardItem !== 'undefined'
    && typeof navigator.clipboard?.write === 'function';
}

interface CopyImageDeps {
  assetUrl: (src: string) => string;
  loadTheme: () => Promise<string>;
}

/** Draw `job` in a hidden frame of this tab; the frame is gone once it settles. */
async function renderInFrame(job: CopyImageJob, deps: CopyImageDeps): Promise<RasterizedPage> {
  const width = Math.round(job.bounds.w * job.scale);
  const height = Math.round(job.bounds.h * job.scale);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Off the window but displayed: a `display: none` frame never paints, and
  // the page waits on painted frames before it is drawn.
  frame.style.cssText = `position: fixed; left: ${-width - 100}px; top: 0; width: ${width}px; `
    + `height: ${height}px; border: 0; pointer-events: none; visibility: visible;`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const themeCss = await deps.loadTheme();
    const loaded = new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.addEventListener('error', () => reject(new Error('The picture page did not load')), { once: true });
    });
    frame.src = new URL('copyImage.html', document.baseURI).href;
    document.body.appendChild(frame);
    const rendered = (async () => {
      await loaded;
      const render = (frame.contentWindow as unknown as { renderCopyImage?: RenderCopyImage } | null)?.renderCopyImage;
      if (!render) throw new Error('The picture page did not load');
      const page = await render({ job, themeCss, resolveSrc: deps.assetUrl });
      // The frame's Blob belongs to a document about to be removed; keep the bytes.
      return { blob: new Blob([await page.blob.arrayBuffer()], { type: 'image/png' }), skipped: page.skipped };
    })();
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The picture did not finish rendering')), RENDER_TIMEOUT_MS);
    });
    return await Promise.race([rendered, timedOut]);
  } finally {
    clearTimeout(timer);
    frame.remove();
  }
}

/**
 * Put a PNG of `request`'s objects on the clipboard. Must be called from
 * the user's key press or click, before anything is awaited.
 */
export function writeClipboardImage(request: CopyImageRequest, deps: CopyImageDeps): Promise<CopyImageResult> {
  const bounds = selectionBounds(request.slide.elements, request.canvas);
  // No display scale to divide out, unlike the desktop capture: the canvas
  // is drawn at exactly the page's CSS size.
  const scale = copyImageScale(bounds);
  const width = Math.round(bounds.w * scale);
  const height = Math.round(bounds.h * scale);
  const rendered = renderInFrame({ ...request, bounds, scale }, deps);
  const written = navigator.clipboard.write([
    new ClipboardItem({ 'image/png': rendered.then((page) => page.blob) }),
  ]);
  // A failed drawing also fails the write; report the drawing's reason.
  written.catch(() => {});
  return (async () => {
    const { skipped } = await rendered;
    await written;
    return { width, height, skipped };
  })();
}
