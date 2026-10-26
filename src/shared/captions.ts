import type { Deck, SlideElement, TextEl } from './deck.js';
import { makeId } from './geometry.js';

/**
 * Figure captions: a caption-role text box attached to a picture or video.
 *
 * The caption names its media in `captionFor`. It sits a fixed gap below the
 * media, exactly as wide and with the same left edge, however the media is
 * moved or resized: `syncCaptions` re-places every attached caption on every
 * commit, so no gesture, panel field or key has to remember to. Its height is
 * the author's, so a two-line caption can be made taller.
 *
 * A new caption holds prompt text and the `placeholder` class, which hides it
 * when presenting, exporting and in thumbnails until someone writes in it.
 */

/** The gap between a picture's bottom edge and its caption, in canvas px. */
export const CAPTION_GAP = 16;

/** The prompt a new, unwritten caption shows in the editor. */
export const CAPTION_PROMPT = 'Add a caption';

type Media = Extract<SlideElement, { type: 'image' | 'video' }>;

export function isCaptionable(element: SlideElement): element is Media {
  return element.type === 'image' || element.type === 'video';
}

/** The caption attached to `mediaId` among `elements`, if any. */
export function captionOf(elements: readonly SlideElement[], mediaId: string): TextEl | null {
  return elements.find((element): element is TextEl =>
    element.type === 'text' && element.captionFor === mediaId) ?? null;
}

/** Where a caption belongs under its media: left edge, width and top. */
export function captionPlacement(media: Pick<SlideElement, 'x' | 'y' | 'w' | 'h'>): { x: number; y: number; w: number } {
  return { x: media.x, y: media.y + media.h + CAPTION_GAP, w: media.w };
}

/** One line of caption-role text, from the deck's theme sizes. */
function captionHeight(deck: Pick<Deck, 'themeStyle'>): number {
  const caption = deck.themeStyle?.fonts?.caption;
  const size = caption?.size ?? 26;
  const lineHeight = caption?.lineHeight ?? 1.3;
  return Math.ceil(size * lineHeight) + 8;
}

/**
 * A new caption for `media`, placed under it. When the canvas has no room
 * below, the media is lifted (mutated) just far enough for the caption to
 * fit, rather than letting the caption hang off the slide.
 */
export function createCaption(media: Media, deck: Pick<Deck, 'canvas' | 'themeStyle'>): TextEl {
  const h = captionHeight(deck);
  const overflow = media.y + media.h + CAPTION_GAP + h - deck.canvas.h;
  if (overflow > 0) media.y = Math.max(0, media.y - overflow);
  return {
    id: makeId('caption'),
    type: 'text',
    ...captionPlacement(media),
    h,
    rot: 0,
    z: media.z + 1,
    opacity: 1,
    class: ['role-caption', 'placeholder'],
    style: {},
    html: `<p>${CAPTION_PROMPT}</p>`,
    align: 'left',
    valign: 'top',
    captionFor: media.id,
  };
}

/**
 * Re-place every attached caption on the slides that changed between
 * `previous` and `next`. Copy-on-write: slides, element arrays and captions
 * are replaced rather than edited, since unchanged ones are shared with
 * `previous`. A caption whose media is gone keeps its text and simply stops
 * being attached; deleting the media deletes its caption (see
 * `withoutCaptionsOf`), so this only meets media that left another way, such
 * as an import that renamed it.
 */
export function syncCaptions<T extends Pick<Deck, 'slides'>>(previous: T | null, next: T): T {
  let slides: T['slides'] | null = null;
  next.slides.forEach((slide, index) => {
    if (previous && previous.slides[index] === slide) return;
    if (!slide.elements.some((element) => element.type === 'text' && element.captionFor)) return;
    const media = new Map(slide.elements.filter(isCaptionable).map((element) => [element.id, element]));
    let changed = false;
    const elements = slide.elements.map((element) => {
      if (element.type !== 'text' || !element.captionFor) return element;
      const owner = media.get(element.captionFor);
      if (!owner) {
        changed = true;
        const { captionFor: _gone, ...unattached } = element;
        return unattached;
      }
      const place = captionPlacement(owner);
      if (element.x === place.x && element.y === place.y && element.w === place.w && element.rot === 0) {
        return element;
      }
      changed = true;
      return { ...element, ...place, rot: 0 };
    });
    if (!changed) return;
    slides ??= next.slides.slice();
    slides[index] = { ...slide, elements };
  });
  return slides ? { ...next, slides } : next;
}

/** The ids of the captions attached to any of `mediaIds`. */
export function captionsOf(elements: readonly SlideElement[], mediaIds: ReadonlySet<string>): string[] {
  return elements
    .filter((element) => element.type === 'text' && element.captionFor && mediaIds.has(element.captionFor))
    .map((element) => element.id);
}

/**
 * Give copied captions the new ids of their copied media. A caption copied
 * without its media is no longer anyone's caption.
 */
export function remapCaptions(elements: SlideElement[], remap: ReadonlyMap<string, string>): void {
  for (const element of elements) {
    if (element.type !== 'text' || !element.captionFor) continue;
    const id = remap.get(element.captionFor);
    if (id) element.captionFor = id;
    else delete element.captionFor;
  }
}
