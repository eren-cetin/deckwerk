import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  freePort,
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
 * Paste and Match Style in the real desktop app: ⇧⌘V in a text box puts the
 * clipboard's words in at the caret wearing the box's own style, where ⌘V
 * brings the copied bold, colour and table along. The clipboard is written in
 * the main process, the way another app would have left it.
 */

const TEXT_ID = 'paste-plain-text';
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
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

/** Styled words with a tab in them: rich text that also reads as a table row. */
const COPY_STYLED = `(() => {
  require('electron').clipboard.write({
    html: '<b style="color: rgb(255, 0, 0)">Red words</b>\\tcell',
    text: 'Red words\\tcell',
  });
  return true;
})()`;

describe.skipIf(!electronBinary)('Paste and Match Style in the desktop app', () => {
  it('pastes plain text in the box’s style with ⇧⌘V, and styled text with ⌘V', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-paste-plain-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-paste-plain-test');

    const deck = emptyDeck('Paste plain');
    deck.slides[0].elements.push({
      id: TEXT_ID, type: 'text', x: 160, y: 200, w: 1600, h: 500, rot: 0, z: 1, opacity: 1,
      class: ['role-body'], style: {}, html: '<p>Start here</p>', align: 'left', valign: 'top',
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.role-body { font: 400 42px/1.35 Arial, sans-serif; }\n', 'utf8');

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
      `document.querySelector(${JSON.stringify(CONTENT)})?.textContent === 'Start here'`), 'the editor never loaded');
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');

    const live = () => editor!.evaluate<string>(`document.querySelector(${JSON.stringify(CONTENT)}).innerHTML`);
    /** The box as drawn once editing ends: what the deck now holds. */
    const saved = async () => (await editor!.evaluate<boolean>('document.activeElement?.isContentEditable === true'))
      ? '' : live();
    /** Edit the box with the caret after its last word. */
    const editAtEnd = async () => {
      await editor!.doubleClick(`#canvas [data-element-id="${TEXT_ID}"]`);
      await eventually(async () => editor!.evaluate<boolean>(
        `document.activeElement === document.querySelector(${JSON.stringify(CONTENT)})`), 'the box never took the caret');
      await editor!.evaluate(`(() => {
        const text = document.querySelector(${JSON.stringify(CONTENT)}).querySelector('p').lastChild;
        const range = document.createRange();
        range.setStart(text, text.length);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return true;
      })()`);
    };

    // The menu shows the key.
    const item = await inMain<{ accelerator: string } | null>(`(() => {
      const edit = require('electron').Menu.getApplicationMenu().items.find((entry) => entry.label === 'Edit');
      const found = edit?.submenu?.items.find((entry) => entry.role === 'pasteandmatchstyle');
      return found ? { accelerator: found.accelerator } : null;
    })()`);
    expect(item).toEqual({ accelerator: 'Shift+CmdOrCtrl+V' });

    expect(await inMain<boolean>(COPY_STYLED)).toBe(true);
    await editAtEnd();
    await editor.chord('V', 'KeyV', 86, MOD | SHIFT);
    await eventually(live, '⇧⌘V pasted nothing', (html) => html.includes('Red words'));
    const plain = await live();
    expect(plain).not.toMatch(/<b\b|<strong\b|<table\b|color/i);
    expect(plain).toContain('Start here');
    await editor.key('Escape', 27);
    await eventually(saved, 'the paste was not saved', (html) => html.includes('Red words'));
    expect(await saved()).not.toMatch(/<b\b|<strong\b|<table\b|color/i);

    // Soundness: the same clipboard through ⌘V does carry its styling, so the
    // check above is not passing on a clipboard that held nothing to strip.
    await editor.chord('z', 'KeyZ', 90, MOD);
    await eventually(saved, 'undo did not take the paste back', (html) => html === '<p>Start here</p>');
    await editAtEnd();
    await editor.chord('v', 'KeyV', 86, MOD, ['paste']);
    await wait(300);
    expect(await live()).toMatch(/<b\b|<strong\b|<table\b|color/i);
  });
});
