import { describe, expect, it } from 'vitest';
import type { SlideElement } from '../src/shared/deck.js';
import {
  COPY_IMAGE_MAX_SIDE,
  COPY_IMAGE_PADDING,
  COPY_IMAGE_SCALE,
  copyImageScale,
  selectionBounds,
} from '../src/shared/copyImage.js';

const CANVAS = { w: 1920, h: 1080 };

const box = (x: number, y: number, w: number, h: number, rot = 0): SlideElement => ({
  id: `box-${x}-${y}`, type: 'shape', shape: 'rect', x, y, w, h, rot, z: 1, opacity: 1,
  class: [], style: {}, fill: '#f00', stroke: null, strokeWidth: 0, radius: 0,
  path: null, pathSize: null, arrowStart: false, arrowEnd: false,
});

describe('Copy as Image bounds', () => {
  it('covers every selected object, with padding', () => {
    const pad = COPY_IMAGE_PADDING;
    expect(selectionBounds([box(200, 100, 400, 200), box(700, 500, 100, 50)], CANVAS))
      .toEqual({ x: 200 - pad, y: 100 - pad, w: 600 + 2 * pad, h: 450 + 2 * pad });
  });

  it('covers the corners a rotation swings out', () => {
    // A 200×100 box turned a quarter turn about its centre (400, 350) stands 100×200.
    expect(selectionBounds([box(300, 300, 200, 100, 90)], CANVAS, 0))
      .toEqual({ x: 350, y: 250, w: 100, h: 200 });
  });

  it('stays on the canvas', () => {
    expect(selectionBounds([box(-50, 1000, 300, 200)], CANVAS)).toEqual({ x: 0, y: 984, w: 266, h: 96 });
  });

  it('draws at three image pixels per canvas pixel unless that would be too large', () => {
    expect(copyImageScale({ x: 0, y: 0, w: 600, h: 400 })).toBe(COPY_IMAGE_SCALE);
    expect(copyImageScale({ x: 0, y: 0, w: 1920, h: 1080 })).toBe(COPY_IMAGE_SCALE);
    // A 4K canvas would make a 11520 px picture.
    expect(copyImageScale({ x: 0, y: 0, w: 3840, h: 2160 }) * 3840).toBeCloseTo(COPY_IMAGE_MAX_SIDE);
  });
});
