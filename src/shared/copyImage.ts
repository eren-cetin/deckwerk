import type { Slide, SlideElement } from './deck.js';

/**
 * Copy as Image: the selected objects drawn over their slide's background,
 * cropped to the selection, as a PNG on the OS clipboard.
 *
 * The ordinary copy carries the objects themselves under a private pasteboard
 * format, which only DeckWerk reads; PowerPoint, Keynote, Word and mail
 * clients find nothing they can paste. Electron cannot put that format and an
 * image on the pasteboard together (every write replaces the last), so the
 * picture is its own command.
 */

/** Background left around the selection, in canvas px: room for shadows and strokes. */
export const COPY_IMAGE_PADDING = 16;

/** The image's pixels per canvas px, so a pasted picture stays sharp when enlarged. */
export const COPY_IMAGE_SCALE = 3;

/** Longest side of the image, in px; keeps a whole-slide copy within GPU limits. */
export const COPY_IMAGE_MAX_SIDE = 6000;

export interface CopyImageRequest {
  /** The selection's slide, holding only the selected objects and no builds. */
  slide: Slide;
  canvas: { w: number; h: number };
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A copy job as the hidden capture page receives it. */
export interface CopyImageJob extends CopyImageRequest {
  bounds: Bounds;
  /** CSS px per canvas px on the capture page; the display scale makes up the rest. */
  scale: number;
}

/** Result of a copy: the PNG's size in px. */
export interface CopyImageResult {
  width: number;
  height: number;
}

/**
 * The canvas region a picture of `elements` covers: the union of their
 * rotated boxes, padded, then kept on the canvas.
 */
export function selectionBounds(
  elements: readonly SlideElement[],
  canvas: { w: number; h: number },
  padding = COPY_IMAGE_PADDING,
): Bounds {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const element of elements) {
    const angle = (element.rot * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const halfW = (element.w * cos + element.h * sin) / 2;
    const halfH = (element.w * sin + element.h * cos) / 2;
    const cx = element.x + element.w / 2;
    const cy = element.y + element.h / 2;
    left = Math.min(left, cx - halfW);
    top = Math.min(top, cy - halfH);
    right = Math.max(right, cx + halfW);
    bottom = Math.max(bottom, cy + halfH);
  }
  if (!Number.isFinite(left)) return { x: 0, y: 0, w: canvas.w, h: canvas.h };
  const x = Math.max(0, Math.floor(left - padding));
  const y = Math.max(0, Math.floor(top - padding));
  const w = Math.max(1, Math.min(canvas.w, Math.ceil(right + padding)) - x);
  const h = Math.max(1, Math.min(canvas.h, Math.ceil(bottom + padding)) - y);
  return { x, y, w, h };
}

/** How many image px per canvas px a picture of `bounds` is drawn at. */
export function copyImageScale(bounds: Bounds): number {
  return Math.min(COPY_IMAGE_SCALE, COPY_IMAGE_MAX_SIDE / Math.max(bounds.w, bounds.h));
}

/** The slide a picture of `selected` is drawn from: its background and layout, those objects, no builds. */
export function copyImageSlide(slide: Slide, selected: readonly SlideElement[]): Slide {
  return { ...slide, elements: [...selected], timeline: [] };
}
