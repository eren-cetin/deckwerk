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
  stopBrowser,
} from './support/browserSession.js';
import {
  isEditorTarget,
  launchDesktopApp,
  materializeDesktopApp,
  NEEDS_VISIBLE_WINDOW_ON_CI,
} from './support/desktopApp.js';

/**
 * Case in the real desktop app: a label drawn in capitals by a theme class
 * (a deck's kicker style) goes back to the case it was typed in from the
 * Case strip, and that choice is saved with the deck.
 */

const LABEL_ID = 'case-label';
const CONTENT = `#canvas [data-element-id="${LABEL_ID}"] .text-content`;

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

describe.skipIf(!electronBinary)('text case in the desktop app', () => {
  it('draws a theme-capitalised label as typed, and saves the choice', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-text-case-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-text-case-test');

    const deck = emptyDeck('Case');
    deck.slides[0].elements.push({
      id: LABEL_ID, type: 'text', x: 160, y: 200, w: 1200, h: 120, rot: 0, z: 1, opacity: 1,
      class: ['role-body', 'kicker'], style: {}, align: 'left', valign: 'top',
      html: '<p>Explicit 3D representation</p>',
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.kicker { text-transform: uppercase; }\n', 'utf8');

    const app = await launchDesktopApp(appDir, [deckDir], { profileDir, visible: NEEDS_VISIBLE_WINDOW_ON_CI });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log, 20_000);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const drawn = () => editor!.evaluate<string>(`getComputedStyle(document.querySelector('${CONTENT}')).textTransform`);
    await eventually(drawn, 'the theme class never capitalised the label', (value) => value === 'uppercase');
    await editor.call('Page.bringToFront');

    await editor.click(`#canvas [data-element-id="${LABEL_ID}"]`);
    const active = () => editor!.evaluate<string | null>(
      `document.querySelector('#inspector .text-case .segment-button.is-active')?.title ?? null`);
    await eventually(active, 'the Case strip does not show the capitals', (value) => value === 'All capitals');

    await editor.click('#inspector .text-case .segment-button[title="As typed"]');
    await eventually(drawn, 'As typed did not undo the capitals', (value) => value === 'none');
    expect(await active()).toBe('As typed');

    await editor.chord('s', 'KeyS', 83, process.platform === 'darwin' ? 4 : 2);
    await eventually(async () => {
      const saved = await editor!.evaluate<{ slides: Array<{ elements: Array<{ id: string; style: Record<string, string> }> }> }>(
        'window.api.getDeck().then((session) => session.deck)');
      return saved.slides[0].elements.find((element) => element.id === LABEL_ID)?.style['text-transform'] ?? null;
    }, 'the case was not saved', (value) => value === 'none');
  });
});
