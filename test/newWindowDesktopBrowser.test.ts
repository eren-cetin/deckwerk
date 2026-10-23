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
  freePort,
  stopBrowser,
} from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * Where you are and another place to go: the toolbar writes the open deck's
 * folder (the path to it, then its own name) with a menu to show or copy it,
 * and File › New Window -- from the application menu and from the toolbar's
 * File menu -- opens another window on the welcome screen for another deck.
 */

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


/**
 * Evaluate in the main process. Its console's command-line API provides
 * `require`, which an ES-module main process otherwise lacks there.
 */
async function inMain<T>(expression: string): Promise<T> {
  const result = await main!.call('Runtime.evaluate', {
    expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'main evaluation failed');
  return result.result?.value as T;
}

const editorWindows = () => inMain<number>(
  "require('electron').BrowserWindow.getAllWindows().filter((win) => win.webContents.getURL().includes('editor')).length");

describe.skipIf(!electronBinary)('the deck path and New Window', () => {
  it('shows the deck folder in the toolbar and opens empty windows', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-new-window-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'Talks', 'Looped Transformer');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-new-window-test');
    await saveDeck(deckDir, emptyDeck('Looped'));

    const inspectPort = await freePort();
    const app = await launchDesktopApp(appDir, [`--inspect=${inspectPort}`, deckDir], { profileDir });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log, 20_000);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const inspector = await eventually(async () => {
      const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json() as Array<{ webSocketDebuggerUrl: string }>;
      return list[0]?.webSocketDebuggerUrl ?? null;
    }, 'the main process inspector never came up', (url) => url !== null);
    main = await Cdp.connect(inspector!);
    await eventually(async () => editor!.evaluate<boolean>(
      'Boolean(document.querySelector("#canvas .stage .slide")) && !document.body.classList.contains("welcome-mode")'),
    'the editor never opened the deck');
    await inMain("require('electron').BrowserWindow.getAllWindows().forEach((win) => win.setSize(1600, 900)) || true");

    // The folder: its name in bold, the path leading to it before it.
    const label = await eventually(async () => editor!.evaluate<{ parent: string; name: string; title: string }>(`({
      parent: document.querySelector('.bar-deck-parent bdi').textContent,
      name: document.querySelector('.bar-deck-folder').textContent,
      title: document.querySelector('.bar-deck-name').title,
    })`), 'the toolbar shows no deck folder', (value) => value.name === 'Looped Transformer');
    expect(label.parent.endsWith('/Talks/')).toBe(true);
    expect(label.title.startsWith(deckDir)).toBe(true);
    await editor.click('.bar-deck-name', 'deck folder');
    expect(await editor.evaluate<string[]>(
      '[...document.querySelectorAll("#ctx-menu button")].map((row) => row.textContent)'))
      .toEqual(['Show in Finder', 'Copy path']);
    await editor.evaluate('(document.getElementById("ctx-menu")?.remove(), true)');

    // File › New Window in the application menu: a second, empty window.
    expect(await editorWindows()).toBe(1);
    await inMain(`(() => {
      const file = require('electron').Menu.getApplicationMenu().items.find((item) => item.label === 'File');
      const item = file.submenu.items.find((candidate) => candidate.label === 'New Window');
      if (item.accelerator !== 'Shift+CmdOrCtrl+N') throw new Error('New Window has no key');
      item.click();
      return true;
    })()`);
    await eventually(editorWindows, 'the menu opened no window', (count) => count === 2);

    // The toolbar's File menu does the same.
    await editor.clickByText('.shape-menu-trigger', 'File', 'File');
    await editor.clickByText('.shape-menu-item', 'New Window', 'File → New Window');
    await eventually(editorWindows, 'the toolbar opened no window', (count) => count === 3);

    // The new windows wait on the welcome screen, holding no deck.
    const welcome = await inMain<boolean[]>(`Promise.all(require('electron').BrowserWindow.getAllWindows()
      .filter((win) => win.webContents.getURL().includes('editor'))
      .map((win) => win.webContents.executeJavaScript('document.body.classList.contains("welcome-mode")')))`);
    expect(welcome.filter(Boolean)).toHaveLength(2);
  });
});
