import { describe, expect, it } from 'vitest';
import {
  CAPTION_GAP,
  captionOf,
  createCaption,
  remapCaptions,
  syncCaptions,
} from '../src/shared/captions.js';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';

/**
 * Figure captions: where a new one goes, how it keeps to its picture, and
 * what happens to it when the picture is copied or goes away.
 */

function image(overrides: Partial<SlideElement> = {}): Extract<SlideElement, { type: 'image' }> {
  return {
    id: 'image-1', type: 'image', x: 200, y: 100, w: 800, h: 500, rot: 0, z: 3, opacity: 1,
    class: [], style: {}, src: 'assets/figure.png', fit: 'contain', alt: '', sourceBox: null,
    ...overrides,
  } as Extract<SlideElement, { type: 'image' }>;
}

describe('a new caption', () => {
  it('sits the standard gap below its picture, as wide, as unwritten caption-role text', () => {
    const deck = emptyDeck('Captions');
    const caption = createCaption(image(), deck);
    expect(caption).toMatchObject({
      type: 'text', captionFor: 'image-1', x: 200, y: 100 + 500 + CAPTION_GAP, w: 800, z: 4,
      class: ['role-caption', 'placeholder'],
    });
    expect(caption.h).toBeGreaterThan(0);
  });

  it('lifts a picture too low for its caption so both stay on the slide', () => {
    const deck = emptyDeck('Captions');
    const low = image({ y: 560 });
    const caption = createCaption(low, deck);
    expect(caption.y + caption.h).toBe(deck.canvas.h);
    expect(low.y).toBe(caption.y - CAPTION_GAP - low.h);
  });
});

describe('keeping captions to their pictures', () => {
  const deckWith = (elements: SlideElement[]) => {
    const deck = emptyDeck('Captions');
    deck.slides[0].elements = elements;
    return deck;
  };

  it('puts a caption back under its picture after the picture moves, without touching the old deck', () => {
    const picture = image();
    const before = deckWith([picture, createCaption(picture, emptyDeck('x'))]);
    const after = structuredClone(before);
    const moved = after.slides[0].elements[0];
    moved.x = 40;
    moved.y = 60;
    moved.w = 1000;
    const synced = syncCaptions(before, after);
    expect(captionOf(synced.slides[0].elements, 'image-1')).toMatchObject({ x: 40, y: 60 + 500 + CAPTION_GAP, w: 1000 });
    expect(captionOf(before.slides[0].elements, 'image-1')).toMatchObject({ x: 200, w: 800 });
  });

  it('keeps the height the author gave the caption', () => {
    const picture = image();
    const caption = { ...createCaption(picture, emptyDeck('x')), h: 120 };
    const deck = deckWith([picture, { ...caption, x: 0, y: 0 }]);
    expect(captionOf(syncCaptions(null, deck).slides[0].elements, 'image-1')?.h).toBe(120);
  });

  it('leaves slides that did not change alone, by identity', () => {
    const picture = image();
    const deck = deckWith([picture, createCaption(picture, emptyDeck('x'))]);
    const next = { ...deck, slides: deck.slides.slice() };
    expect(syncCaptions(deck, next)).toBe(next);
  });

  it('detaches a caption whose picture is gone, keeping its words', () => {
    const caption = { ...createCaption(image(), emptyDeck('x')), html: '<p>Figure 2</p>' };
    const synced = syncCaptions(null, deckWith([caption]));
    const [kept] = synced.slides[0].elements;
    expect(kept).toMatchObject({ type: 'text', html: '<p>Figure 2</p>' });
    expect('captionFor' in kept).toBe(false);
  });
});

describe('copying captions', () => {
  it('points a copied caption at the copy of its picture, and frees one copied alone', () => {
    const picture = image();
    const withPicture = createCaption(picture, emptyDeck('x'));
    const alone = { ...createCaption(image({ id: 'image-2' }), emptyDeck('x')), id: 'caption-alone' };
    const copies: SlideElement[] = [structuredClone(withPicture), structuredClone(alone)];
    remapCaptions(copies, new Map([['image-1', 'image-9']]));
    expect(copies[0]).toMatchObject({ captionFor: 'image-9' });
    expect('captionFor' in copies[1]).toBe(false);
  });
});
