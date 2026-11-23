import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
} from './support/browserSession.js';
import {
  isEditorTarget,
  launchDesktopApp,
  materializeDesktopApp,
  NEEDS_VISIBLE_WINDOW_ON_CI,
} from './support/desktopApp.js';

/**
 * Rename in the real desktop app: the deck folder's menu in the toolbar
 * renames the folder where it stands, the window carries on with the deck at
 * its new path, and a name already taken is refused with the deck untouched.
 */

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

/** Open the folder menu, choose Rename…, type `name` and press Enter. */
async function renameTo(name: string): Promise<void> {
  await editor!.click('.bar-deck-name');
  await eventually(() => editor!.evaluate<string[]>(
    `[...document.querySelectorAll('#ctx-menu button')].map((row) => row.textContent)`),
  'the folder menu never opened', (rows) => rows.includes('Rename…'));
  await editor!.evaluate(`([...document.querySelectorAll('#ctx-menu button')]
    .find((row) => row.textContent === 'Rename…').click(), true)`);
  await eventually(() => editor!.evaluate<boolean>(`Boolean(document.querySelector('.deck-rename input'))`),
    'the rename dialog never opened', Boolean);
  await editor!.evaluate(`(() => {
    const input = document.querySelector('.deck-rename input');
    input.value = ${JSON.stringify(name)};
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
}

describe.skipIf(!electronBinary)('renaming a presentation in the desktop app', () => {
  it('renames the deck folder in place from the toolbar', { retry: 2, timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-rename-'));
    const appDir = join(workDir, 'app');
    const decks = join(workDir, 'decks');
    const before = join(decks, 'Untitled deck');
    const after = join(decks, 'Doctoral Day');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await mkdir(join(decks, 'Taken'), { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-rename-test');
    const deck = emptyDeck('Untitled deck');
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'second' });
    deck.slides[1].elements.push({
      id: 'box', type: 'shape', shape: 'rect', x: 200, y: 200, w: 400, h: 200, rot: 0, z: 100, opacity: 1,
      class: [], style: {}, fill: '#3366ff', stroke: null, strokeWidth: 0, radius: 0,
      path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    });
    await saveDeck(before, deck);

    const app = await launchDesktopApp(appDir, [before], { profileDir, visible: NEEDS_VISIBLE_WINDOW_ON_CI });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log, 20_000);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const folderLabel = () => editor!.evaluate<string>(`document.querySelector('.bar-deck-folder')?.textContent ?? ''`);
    await eventually(folderLabel, 'the deck never opened', (name) => name === 'Untitled deck');
    await editor.call('Page.bringToFront');
    // Work on the second slide, which a rename must not move the author off.
    await editor.click('#rail .rail-item[data-slide-id="second"]');
    const onSecond = () => editor!.evaluate<boolean>(
      `document.querySelector('#rail .rail-item[data-slide-id="second"]')?.classList.contains('active') ?? false`);
    await eventually(onSecond, 'the second slide never became current', Boolean);
    // An edit made before the rename, to undo after it.
    await editor.click('#canvas .stage [data-element-id="box"]');
    await eventually(() => editor!.evaluate<number>('document.querySelectorAll("#canvas .sel-box").length'),
      'the box was never selected', (count) => count === 1);
    await editor.key('Backspace', 8);
    await eventually(() => editor!.evaluate<boolean>(`!document.querySelector('#canvas .stage [data-element-id="box"]')`),
      'the box was not deleted', Boolean);

    // A name another folder already has is refused, and nothing moves.
    await renameTo('Taken');
    await eventually(() => editor!.evaluate<string>(`document.getElementById('status')?.textContent ?? ''`),
      'the clash was not reported', (text) => /already a folder named/.test(text));
    expect(existsSync(join(before, 'deck.json'))).toBe(true);

    await renameTo('Doctoral Day');
    await eventually(folderLabel, 'the toolbar kept the old name', (name) => name === 'Doctoral Day');
    expect(existsSync(before)).toBe(false);
    expect(existsSync(join(after, 'deck.json'))).toBe(true);
    const open = await editor.evaluate<{ dir: string; slides: number }>(
      `window.api.getDeck().then((session) => ({ dir: session.dir, slides: session.deck.slides.length }))`);
    expect(open).toEqual({ dir: after, slides: 2 });
    expect(await onSecond()).toBe(true);

    // The history moved with the folder: the deletion before the rename undoes.
    await editor.chord('z', 'KeyZ', 90, process.platform === 'darwin' ? 4 : 2);
    await eventually(() => editor!.evaluate<boolean>(`Boolean(document.querySelector('#canvas .stage [data-element-id="box"]'))`),
      'the edit made before the rename could not be undone', Boolean);
    // And the next autosave writes into the renamed folder.
    await eventually(() => readFile(join(after, 'deck.json'), 'utf8'),
      'the undo was never saved into the renamed folder', (json) => json.includes('"box"'));
    expect(existsSync(before)).toBe(false);
  });
});
