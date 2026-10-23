import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  stopBrowser,
  wait,
} from './support/browserSession.js';
import {
  isEditorTarget,
  launchDesktopApp,
  materializeDesktopApp,
  NEEDS_VISIBLE_WINDOW_ON_CI,
} from './support/desktopApp.js';

/**
 * Colouring several table cells at once in the real desktop app, with real
 * pointer input: double-click into the table, ⌘-click other cells, and the
 * panel's Colour paints the text of exactly the cells picked — including
 * words that came with a colour of their own, which used to hide it.
 */

const TABLE_ID = 'cell-range-table';
const TABLE = `#canvas [data-element-id="${TABLE_ID}"] table`;
const MOD = process.platform === 'darwin' ? 4 : 2;

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('picking table cells in the desktop app', () => {
  it('⌘-clicks scattered cells and colours only their text', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-cell-range-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-cell-range-test');

    // Every word carries its own colour, the way pasted or authored tables do.
    const row = (r: number) => [0, 1, 2]
      .map((c) => `<td><span style="color: rgb(0, 0, 255);">r${r}c${c}</span></td>`).join('');
    const deck = emptyDeck('Cell range');
    deck.slides[0].elements.push({
      id: TABLE_ID, type: 'text', x: 160, y: 200, w: 1200, h: 300, rot: 0, z: 1, opacity: 1,
      class: ['role-body', 'table-default'], style: {}, align: 'left', valign: 'top',
      html: `<table><tbody><tr>${row(0)}</tr><tr>${row(1)}</tr><tr>${row(2)}</tr></tbody></table>`,
      table: { columnWidths: [1, 1, 1], autoHeight: true },
    });
    await saveDeck(deckDir, deck);

    const app = await launchDesktopApp(appDir, [deckDir], { profileDir, visible: NEEDS_VISIBLE_WINDOW_ON_CI });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log, 20_000);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('${TABLE}'))`),
      'the editor never showed the table');
    await editor.call('Page.bringToFront');

    const centre = (r: number, c: number) => editor!.evaluate<{ x: number; y: number }>(`(() => {
      const box = document.querySelector('${TABLE}').rows[${r}].cells[${c}].getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    const press = async (x: number, y: number, clickCount: number, modifiers = 0) => {
      await editor!.call('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, clickCount, button: 'left', buttons: 1, modifiers,
      });
      await editor!.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, clickCount, button: 'left', buttons: 0, modifiers,
      });
    };
    const colours = () => editor!.evaluate<string[][]>(`[...document.querySelector('${TABLE}').rows]
      .map((row) => [...row.cells].map((cell) => getComputedStyle(cell.querySelector('span') ?? cell).color))`);

    // Double-click into the first cell (it selects the word), then ⌘-click
    // the middle and the last one.
    const first = await centre(0, 0);
    await editor.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, button: 'none', buttons: 0 });
    await press(first.x, first.y, 1);
    await press(first.x, first.y, 2);
    await wait(300);
    for (const [r, c] of [[1, 1], [2, 2]] as const) {
      const cell = await centre(r, c);
      await press(cell.x, cell.y, 1, MOD);
    }
    await eventually(async () => editor!.evaluate<number>(`document.querySelectorAll('${TABLE} .editor-table-selected').length`),
      '⌘-click did not pick the cells', (count) => count === 3);

    // The panel's Colour, white from the picker's neutrals.
    await editor.evaluate(`(() => {
      [...document.querySelectorAll('#inspector .color-picker-trigger')]
        .find((trigger) => trigger.getAttribute('aria-label').startsWith('Colour')).click();
      return true;
    })()`);
    await editor.click('.color-picker-popover .color-picker-palette-neutrals .color-picker-palette-button:nth-child(1)');

    const white = 'rgb(255, 255, 255)';
    const blue = 'rgb(0, 0, 255)';
    await eventually(colours, 'the selected cells did not take the colour',
      (grid) => grid[0][0] === white && grid[2][2] === white);
    expect(await colours()).toEqual([
      [white, blue, blue],
      [blue, white, blue],
      [blue, blue, white],
    ]);
  });
});
