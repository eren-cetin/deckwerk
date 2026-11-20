import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { COPY_IMAGE_PADDING, COPY_IMAGE_SCALE } from '../src/shared/copyImage.js';
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
 * Copy as Image in the real desktop app: ⇧⌘C puts a PNG of the selected
 * objects, over the slide's background, on the OS pasteboard, where
 * PowerPoint and Keynote find it. The pasteboard is read in the main process,
 * the way another app would read it.
 */

const MOD = process.platform === 'darwin' ? 4 : 2;
const SHIFT = 8;

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

const rect = (id: string, x: number, y: number, w: number, h: number, fill: string): SlideElement => ({
  id, type: 'shape', shape: 'rect', x, y, w, h, rot: 0, z: 100, opacity: 1,
  class: [], style: {}, fill, stroke: null, strokeWidth: 0, radius: 0,
  path: null, pathSize: null, arrowStart: false, arrowEnd: false,
});

/** The pasteboard's image: its size and the RGB of a few pixels. */
const READ_IMAGE = (points: Array<[number, number]>) => `(() => {
  const image = require('electron').clipboard.readImage();
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  const rgb = ${JSON.stringify(points)}.map(([x, y]) => {
    const i = (y * width + x) * 4;
    return [bitmap[i + 2], bitmap[i + 1], bitmap[i]];
  });
  return { width, height, rgb };
})()`;

describe.skipIf(!electronBinary)('Copy as Image in the desktop app', () => {
  it('puts a picture of only the selected objects on the pasteboard with ⇧⌘C', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-copy-image-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-copy-image-test');

    const deck = emptyDeck('Copy image');
    deck.slides[0].background = { color: 'rgb(16, 32, 48)', image: null };
    // The blue box sits inside the red one's padding: a picture of the
    // selection must not show it.
    // Above the empty slide's layout placeholders, which would take the click.
    deck.slides[0].elements.push(
      rect('red', 200, 100, 400, 200, '#ff0000'),
      rect('blue', 606, 100, 200, 200, '#0000ff'),
    );
    await saveDeck(deckDir, deck);

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
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('#canvas .stage [data-element-id="red"]'))`), 'the editor never loaded');
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');

    // The menu shows the key.
    const item = await inMain<{ accelerator: string } | null>(`(() => {
      const edit = require('electron').Menu.getApplicationMenu().items.find((entry) => entry.label === 'Edit');
      const found = edit?.submenu?.items.find((entry) => entry.label === 'Copy as Image');
      return found ? { accelerator: found.accelerator } : null;
    })()`);
    expect(item).toEqual({ accelerator: 'Shift+CmdOrCtrl+C' });

    await inMain(`require('electron').clipboard.writeText('before'), true`);
    await editor.click('#canvas .stage [data-element-id="red"]');
    await eventually(async () => editor!.evaluate<number>('document.querySelectorAll("#canvas .sel-box").length'),
      'the box was never selected', (count) => count === 1);
    await editor.chord('C', 'KeyC', 67, MOD | SHIFT);

    const s = COPY_IMAGE_SCALE;
    const pad = COPY_IMAGE_PADDING;
    const picture = await eventually(
      () => inMain<{ width: number; height: number; rgb: number[][] } | null>(READ_IMAGE([
        [(pad + 200) * s, (pad + 100) * s], // the red box's centre
        [2, 2], // padding: the slide background
        [(pad + 400 + 10) * s, (pad + 100) * s], // where the unselected blue box is
      ])),
      'nothing reached the pasteboard',
      (value) => value !== null,
    );
    expect(picture).toMatchObject({ width: (400 + 2 * pad) * s, height: (200 + 2 * pad) * s });
    const [red, background, besides] = picture!.rgb;
    expect(red).toEqual([255, 0, 0]);
    expect(background).toEqual([16, 32, 48]);
    expect(besides).toEqual([16, 32, 48]);
  });
});
