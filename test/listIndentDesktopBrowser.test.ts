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
 * List indent in the real desktop app: the − and + beside List move a box's
 * bullets, even in a deck whose theme.css insets every list with an
 * `!important` rule, and the setting is saved with the deck.
 */

const LIST_ID = 'indent-list';
const LIST = `#canvas [data-element-id="${LIST_ID}"] .text-content > ul`;

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

describe.skipIf(!electronBinary)('list indent in the desktop app', () => {
  it('steps the space before the bullets past a theme rule, and saves it', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-list-indent-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-list-indent-test');

    const deck = emptyDeck('List indent');
    deck.slides[0].elements.push({
      id: LIST_ID, type: 'text', x: 160, y: 200, w: 1200, h: 400, rot: 0, z: 1, opacity: 1,
      class: ['role-body'], style: { 'font-size': '30px' }, align: 'left', valign: 'top',
      html: '<ul><li>First point</li><li>Second point</li></ul>',
    });
    await saveDeck(deckDir, deck);
    // The rule a deck's own stylesheet can carry: every list inset 1.25em.
    await writeFile(join(deckDir, 'theme.css'), [
      '.element-text .text-content :is(ul, ol) {',
      '  margin: 0 !important;',
      '  padding-left: 1.25em !important;',
      '}',
      '',
    ].join('\n'), 'utf8');

    const app = await launchDesktopApp(appDir, [deckDir], { profileDir, visible: NEEDS_VISIBLE_WINDOW_ON_CI });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log, 20_000);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const padding = () => editor!.evaluate<number>(
      `parseFloat(getComputedStyle(document.querySelector('${LIST}')).paddingLeft)`);
    await eventually(padding, 'the theme rule never reached the list', (value) => value === 37.5);
    await editor.call('Page.bringToFront');

    await editor.click(`#canvas [data-element-id="${LIST_ID}"]`);
    const shown = () => editor!.evaluate<string | null>(
      `document.querySelector('#inspector .field-list-indent .list-indent-value')?.textContent ?? null`);
    await eventually(shown, 'the List row has no indent control', (value) => value === '38');

    // − lands on the grid below 37.5px, a second − one step further.
    await editor.click('#inspector .field-list-indent .list-indent-less');
    await eventually(padding, '− did not move the bullets', (value) => value === 35);
    await editor.click('#inspector .field-list-indent .list-indent-less');
    await eventually(padding, 'a second − did not move the bullets', (value) => value === 30);
    expect(await shown()).toBe('30');
    await editor.click('#inspector .field-list-indent .list-indent-more');
    await eventually(padding, '+ did not move the bullets back', (value) => value === 35);

    await editor.chord('s', 'KeyS', 83, process.platform === 'darwin' ? 4 : 2);
    await eventually(async () => {
      const saved = await editor!.evaluate<{ slides: Array<{ elements: Array<{ id: string; listIndent?: number }> }> }>(
        'window.api.getDeck().then((session) => session.deck)');
      return saved.slides[0].elements.find((element) => element.id === LIST_ID)?.listIndent ?? null;
    }, 'the indent was not saved', (value) => value === 35);
  });
});
