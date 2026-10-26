import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { CAPTION_GAP } from '../src/shared/captions.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  freePort,
  stopBrowser,
} from './support/browserSession.js';
import {
  isEditorTarget,
  launchDesktopApp,
  materializeDesktopApp,
  NEEDS_VISIBLE_WINDOW_ON_CI,
} from './support/desktopApp.js';

/**
 * Figure captions in the real desktop app: an image pasted from the system
 * clipboard with ⌘V arrives with a caption the standard gap below it, and
 * dragging the picture with the mouse carries the caption along.
 */

const MOD = process.platform === 'darwin' ? 4 : 2;

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
let main: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  main?.close();
  main = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/** Evaluate in the main process, where `require` reaches Electron's clipboard. */
async function inMain<T>(expression: string): Promise<T> {
  const result = await main!.call('Runtime.evaluate', {
    expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'main evaluation failed');
  return result.result?.value as T;
}

interface Box { x: number; y: number; w: number; h: number }

describe.skipIf(!electronBinary)('figure captions in the desktop app', () => {
  it('pastes an image with a caption below it that follows a drag', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-caption-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-caption-test');
    await saveDeck(deckDir, emptyDeck('Captions'));

    const inspectPort = await freePort();
    const app = await launchDesktopApp(appDir, [`--inspect=${inspectPort}`, deckDir], {
      profileDir, visible: NEEDS_VISIBLE_WINDOW_ON_CI,
    });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log, 20_000);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const inspector = await eventually(async () => {
      const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json() as Array<{ webSocketDebuggerUrl: string }>;
      return list[0]?.webSocketDebuggerUrl ?? null;
    }, 'the main process inspector never came up', (url) => url !== null);
    main = await Cdp.connect(inspector!);
    await eventually(async () => editor!.evaluate<boolean>('Boolean(document.querySelector("#canvas .stage .slide"))'),
      'the editor never loaded');
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');

    // A 320×180 picture on the system clipboard, as a screenshot leaves it.
    expect(await inMain<boolean>(`(() => {
      const { clipboard, nativeImage } = require('electron');
      const width = 320, height = 180;
      const pixels = Buffer.alloc(width * height * 4, 0x80);
      clipboard.writeImage(nativeImage.createFromBitmap(pixels, { width, height }));
      return !clipboard.readImage().isEmpty();
    })()`)).toBe(true);
    await editor.chord('v', 'KeyV', 86, MOD);

    // Canvas geometry, read from the elements' own authored positions.
    const boxes = () => editor!.evaluate<{ picture: Box | null; caption: Box | null }>(`(() => {
      const read = (node) => node ? {
        x: parseFloat(node.style.left), y: parseFloat(node.style.top),
        w: parseFloat(node.style.width), h: parseFloat(node.style.height),
      } : null;
      return {
        picture: read(document.querySelector('#canvas .slide-layer .element-image')),
        caption: read(document.querySelector('#canvas .slide-layer .element-text.role-caption')),
      };
    })()`);
    const pasted = await eventually(boxes, 'the pasted picture came without a caption',
      (value) => value.picture !== null && value.caption !== null);
    const attached = ({ picture, caption }: { picture: Box | null; caption: Box | null }) =>
      Boolean(picture && caption && caption.x === picture.x && caption.w === picture.w
        && caption.y === picture.y + picture.h + CAPTION_GAP);
    expect(attached(pasted)).toBe(true);
    // An unwritten caption shows its prompt in the editor only.
    expect(await editor.evaluate<string>(
      `document.querySelector('#canvas .slide-layer .element-text.role-caption').textContent.trim()`)).toBe('Add a caption');

    // Drag the picture with the mouse; the caption keeps up during the drag.
    const centre = await editor.evaluate<{ x: number; y: number }>(`(() => {
      const box = document.querySelector('#canvas .slide-layer .element-image').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 3 };
    })()`);
    const mouse = (type: string, x: number, y: number, buttons: number) => editor!.call('Input.dispatchMouseEvent', {
      type, x, y, clickCount: type === 'mouseMoved' ? 0 : 1, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons,
    });
    await mouse('mouseMoved', centre.x, centre.y, 0);
    await mouse('mousePressed', centre.x, centre.y, 1);
    for (let step = 1; step <= 10; step++) await mouse('mouseMoved', centre.x - step * 12, centre.y - step * 6, 1);
    const during = await boxes();
    expect(during.picture!.x).toBeLessThan(pasted.picture!.x);
    expect(attached(during)).toBe(true);
    await mouse('mouseReleased', centre.x - 120, centre.y - 60, 0);
    const dropped = await boxes();
    expect(dropped.picture!.x).toBeLessThan(pasted.picture!.x);
    expect(attached(dropped)).toBe(true);
  });
});
