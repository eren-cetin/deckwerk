import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { COPY_IMAGE_PADDING, COPY_IMAGE_SCALE } from '../src/shared/copyImage.js';
import { electronBinary, eventually, type Cdp } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * Copy as Image in the browser collaboration client: ⇧⌘C and the canvas
 * context menu put a PNG of the selected objects, on a transparent
 * background, on the clipboard through the async Clipboard API. The picture
 * is read back with `navigator.clipboard.read()`, the way a web app the user
 * pastes into would read it.
 */

const DECK_ID = 'copy-image-web';
const MOD = process.platform === 'darwin' ? 4 : 2;
const SHIFT = 8;
const S = COPY_IMAGE_SCALE;
const PAD = COPY_IMAGE_PADDING;

const MP4 = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'testclip.mp4');

const rect = (id: string, x: number, y: number, w: number, h: number, fill: string): SlideElement => ({
  id, type: 'shape', shape: 'rect', x, y, w, h, rot: 0, z: 100, opacity: 1,
  class: [], style: {}, fill, stroke: null, strokeWidth: 0, radius: 0,
  path: null, pathSize: null, arrowStart: false, arrowEnd: false,
});

function fixtureDeck(): Deck {
  const deck = emptyDeck('Copy image');
  deck.slides[0].background = { color: 'rgb(16, 32, 48)', image: null };
  // The blue box sits inside the red one's padding: a picture of the
  // selection must not show it. Above the layout placeholders, which would
  // otherwise take the clicks.
  deck.slides[0].elements.push(
    rect('red', 200, 100, 400, 200, '#ff0000'),
    rect('blue', 606, 100, 200, 200, '#0000ff'),
    {
      id: 'clip', type: 'video', x: 200, y: 500, w: 640, h: 360, rot: 0, z: 101, opacity: 1,
      class: [], style: {}, src: 'assets/testclip.mp4', fit: 'fill', autoplay: false,
      loop: false, muted: true, controls: false, start: 0.5, end: null, poster: null, sourceBox: null,
    },
    {
      id: 'words', type: 'text', x: 1000, y: 500, w: 700, h: 160, rot: 0, z: 102, opacity: 1,
      class: ['role-body'], style: { color: '#000000' }, html: 'Copied words', align: 'left', valign: 'top',
    },
    {
      id: 'handout', type: 'image', x: 1000, y: 700, w: 300, h: 300, rot: 0, z: 103, opacity: 1,
      class: [], style: {}, src: 'assets/handout.pdf', fit: 'contain', alt: 'Handout', sourceBox: null,
    },
  );
  return deck;
}

let session: WebEditorSession | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  session = await launchWebEditor([{
    id: DECK_ID,
    deck: fixtureDeck(),
    files: {
      'assets/testclip.mp4': await readFile(MP4),
      // Never drawn: the picture leaves PDF pages out whatever they hold.
      'assets/handout.pdf': '%PDF-1.4\n%%EOF\n',
    },
  }], {
    userName: 'Copy Image',
    readyWhen: `Boolean(document.querySelector('#canvas [data-element-id="red"]'))`,
    tmpPrefix: 'collab-copy-image-',
  });
  // The async clipboard API refuses a document without focus, and under
  // Xvfb with no window manager X never grants it; see clipboardImageBrowser.
  await session.cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
}, 120_000);

afterAll(async () => {
  await session?.close();
  session = null;
});

function cdp(): Cdp {
  if (!session) throw new Error('the web editor is not running');
  return session.cdp;
}

const ON_CANVAS = (id: string) => `#canvas .stage [data-element-id="${id}"]`;

async function status(): Promise<string> {
  return cdp().evaluate<string>(`document.getElementById('status')?.textContent ?? ''`);
}

/** Put text on the clipboard, so a picture found there afterwards is the copy's. */
async function clearClipboard(): Promise<void> {
  await cdp().evaluate(`navigator.clipboard.writeText('before').then(() => true)`);
}

interface Picture {
  width: number;
  height: number;
  /** RGBA at each requested point. */
  rgba: number[][];
  /** Distinct opaque colours inside `region`, capped. */
  colours: number;
  /** Opaque pixels inside `region`. */
  opaque: number;
}

/** The clipboard's PNG, read the way a web page would paste it, or null. */
async function readPicture(
  points: Array<[number, number]>,
  region: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 1, h: 1 },
): Promise<Picture | null> {
  return cdp().evaluate<Picture | null>(`(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((candidate) => candidate.types.includes('image/png'));
    if (!item) return null;
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const rgba = ${JSON.stringify(points)}.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
    const region = ${JSON.stringify(region)};
    const data = context.getImageData(region.x, region.y, region.w, region.h).data;
    const colours = new Set();
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 255) continue;
      opaque++;
      if (colours.size < 64) colours.add((data[i] >> 4) * 256 + (data[i + 1] >> 4) * 16 + (data[i + 2] >> 4));
    }
    return { width: bitmap.width, height: bitmap.height, rgba, colours: colours.size, opaque };
  })()`);
}

async function select(id: string, modifiers = 0): Promise<void> {
  if (modifiers) await cdp().clickModified(ON_CANVAS(id), modifiers, id);
  else await cdp().click(ON_CANVAS(id), id);
  await eventually(
    () => cdp().evaluate<string[]>('[...window.store.get().selection]'),
    `${id} was never selected`,
    (selection) => selection.includes(id),
  );
}

describe.skipIf(!electronBinary)('Copy as Image in the browser editor', () => {
  it('puts a transparent picture of only the selected objects on the clipboard with ⇧⌘C', async () => {
    await clearClipboard();
    await select('red');
    await cdp().chord('C', 'KeyC', 67, MOD | SHIFT);
    const width = (400 + 2 * PAD) * S;
    const height = (200 + 2 * PAD) * S;
    await eventually(status, 'the copy never reported',
      (text) => text.includes(`Copied 1 object as a ${width} × ${height} px image.`));

    const picture = await readPicture([
      [(PAD + 200) * S, (PAD + 100) * S], // the red box's centre
      [2, 2], // padding: transparent, not the slide background
      [(PAD + 400 + 10) * S, (PAD + 100) * S], // where the unselected blue box is
    ]);
    expect(picture).toMatchObject({ width, height });
    const [red, corner, besides] = picture!.rgba;
    expect(red).toEqual([255, 0, 0, 255]);
    expect(corner[3]).toBe(0);
    expect(besides[3]).toBe(0);
    // Nothing of the copy is left in the page.
    expect(await cdp().evaluate<number>(`document.querySelectorAll('iframe[aria-hidden="true"]').length`)).toBe(0);
  }, 60_000);

  it('pictures a video frame from the context menu', async () => {
    await clearClipboard();
    await cdp().rightClick(ON_CANVAS('clip'), 'video context menu');
    await cdp().clickByText('#ctx-menu button', 'Copy as Image');
    const width = (640 + 2 * PAD) * S;
    const height = (360 + 2 * PAD) * S;
    await eventually(status, 'the copy never reported',
      (text) => text.includes(`Copied 1 object as a ${width} × ${height} px image.`));
    const inside = { x: PAD * S + 30, y: PAD * S + 30, w: 640 * S - 60, h: 360 * S - 60 };
    const picture = await readPicture([[2, 2]], inside);
    expect(picture).toMatchObject({ width, height });
    expect(picture!.rgba[0][3]).toBe(0);
    // A drawn frame: opaque throughout, and not one flat (black) colour.
    expect(picture!.opaque).toBe(inside.w * inside.h);
    expect(picture!.colours).toBeGreaterThan(4);
  }, 60_000);

  it('draws text and leaves a PDF out, saying so', async () => {
    await clearClipboard();
    await select('words');
    await select('handout', SHIFT);
    await cdp().chord('C', 'KeyC', 67, MOD | SHIFT);
    await eventually(status, 'the copy never reported', (text) => text.includes('Copied 2 objects as a'));
    expect(await status()).toContain('1 part (PDF or web page) could not be drawn and was left out.');
    // Bounds: x 1000..1700, y 500..1000, padded.
    const textRegion = { x: PAD * S, y: PAD * S, w: 700 * S, h: 160 * S };
    const picture = await readPicture([[(PAD + 150) * S, (PAD + 350) * S]], textRegion);
    expect(picture).toMatchObject({ width: (700 + 2 * PAD) * S, height: (500 + 2 * PAD) * S });
    // The PDF's box is empty: transparent.
    expect(picture!.rgba[0][3]).toBe(0);
    // The words are drawn: some opaque glyph pixels, far from all of the box.
    expect(picture!.opaque).toBeGreaterThan(1000);
    expect(picture!.opaque).toBeLessThan(textRegion.w * textRegion.h / 2);
  }, 60_000);
});
