import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { electronBinary, eventually, type Cdp } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * Renaming a deck in the browser while it is open in two editor tabs and
 * presented in a third window. Nobody is asked to close anything: every tab
 * follows the deck to its new id, an edit made right afterwards lands in the
 * renamed folder, and the presentation keeps its pictures and keeps
 * following the deck.
 */

const DECK_ID = 'talks/demo';
const MOD = process.platform === 'darwin' ? 4 : 2;
const RENAMED = 'talks/Big Talk';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let session: WebEditorSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

function fixtureDeck(): Deck {
  const base = emptyDeck('demo');
  return parseDeck({
    ...base,
    slides: [{
      ...base.slides[0],
      id: 's1',
      name: 'One',
      elements: [
        { id: 'e1', type: 'text', x: 160, y: 100, w: 1600, h: 200, html: 'HELLO' },
        { id: 'e2', type: 'image', x: 160, y: 400, w: 400, h: 400, src: 'assets/pic.png' },
      ],
    }],
  });
}

/** Where a tab thinks the deck is: its URL and its toolbar label. */
const WHERE = `(() => ({
  deck: new URLSearchParams(location.search).get('deck'),
  label: document.querySelector('.bar-deck-name')?.title.split('\\n')[0] ?? null,
  folder: document.querySelector('.bar-deck-folder')?.textContent ?? null,
}))()`;

/** Whether every picture on the canvas (or stage) has actually loaded. */
const PICTURES_LOADED = (root: string) => `(() => {
  const images = [...document.querySelectorAll(${JSON.stringify(`${root} img`)})];
  return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
})()`;

async function textOnStage(present: Cdp): Promise<string> {
  return present.evaluate<string>(`document.querySelector('#stage .slide')?.textContent ?? ''`);
}

describe.skipIf(!electronBinary)('renaming a deck that is open in the browser', () => {
  it('moves every editor tab and the presentation to the new name without losing an edit', {
    timeout: 180_000,
  }, async () => {
    session = await launchWebEditor(
      [{ id: DECK_ID, deck: fixtureDeck(), files: { 'assets/pic.png': PNG } }],
      { readyWhen: PICTURES_LOADED('#canvas') },
    );
    const first = session.cdp;
    const origin = session.origin;

    // A second editor tab, and a presentation window, on the same deck.
    await first.evaluate(`Boolean(window.open(${JSON.stringify(`${session.editorUrl()}&tab=second`)}, 'second'))`);
    const second = await session.connectTarget((target) => target.url.includes('tab=second'), 'second editor');
    await eventually(() => second.evaluate<boolean>(`(() => (
      document.documentElement.dataset.collabReady === 'true' && ${PICTURES_LOADED('#canvas')}
    ))()`), 'the second editor tab never connected', Boolean);
    await first.evaluate(`Boolean(window.open(
      ${JSON.stringify(`/present.html?deck=${encodeURIComponent(DECK_ID)}&slide=1&channel=${encodeURIComponent(DECK_ID)}`)},
      'present'))`);
    const present = await session.connectTarget((target) => target.url.includes('present.html'), 'presentation');
    await eventually(() => present.evaluate<boolean>(PICTURES_LOADED('#stage')),
      'the presentation never showed its picture', Boolean);
    expect(await textOnStage(present)).toContain('HELLO');

    // An edit in the first tab before the rename, to undo after it.
    await first.call('Page.bringToFront');
    await first.click('button.bar-icon-button[aria-label="Text"]', 'Text');
    await eventually(async () => (await session!.fetchDeck()).slides[0].elements.length,
      'the first text box never reached the server', (count) => count === 3);
    await first.key('Escape', 27);

    // Rename from the first tab's folder menu, typing the name for real.
    const titleBefore = (await session.fetchDeck()).title;
    await first.click('.bar-deck-name', 'deck folder');
    await eventually(() => first.evaluate<string[]>(
      `[...document.querySelectorAll('#ctx-menu button')].map((row) => row.textContent)`),
    'the folder menu never offered Rename Folder…', (rows) => rows.includes('Rename Folder…'));
    await first.clickByText('#ctx-menu button', 'Rename Folder…');
    await eventually(() => first.evaluate<boolean>(
      `document.activeElement === document.querySelector('.deck-rename input')`),
    'the rename dialog never took focus', Boolean);
    expect(await first.evaluate<string>(`document.querySelector('.deck-rename input').value`)).toBe('demo');
    await first.typeKeys('Big Talk');
    await first.key('Enter', 13);

    // Both editor tabs follow: URL, toolbar label, title — no reload.
    for (const [tab, name] of [[first, 'first'], [second, 'second']] as const) {
      const where = await eventually(() => tab.evaluate<{ deck: string; label: string; folder: string }>(WHERE),
        `the ${name} editor tab did not follow the rename`, (value) => value.deck === RENAMED);
      expect(where).toEqual({ deck: RENAMED, label: RENAMED, folder: 'Big Talk' });
    }
    expect(await second.evaluate<string>(`location.search`)).toContain('tab=second');
    expect(await first.evaluate<boolean>(`Boolean(document.querySelector('.deck-rename'))`)).toBe(false);
    // The folder moved; the title inside the deck is a separate name.
    expect((await session.fetchDeck(RENAMED)).title).toBe(titleBefore);
    expect(existsSync(join(session.decksRoot, 'talks', 'demo'))).toBe(false);

    // The presentation follows too, and its pair channel stays the one it opened with.
    const presented = await eventually(() => present.evaluate<{ deck: string | null; channel: string | null }>(`(() => {
      const query = new URLSearchParams(location.search);
      return { deck: query.get('deck'), channel: query.get('channel') };
    })()`), 'the presentation did not follow the rename', (value) => value.deck === RENAMED);
    expect(presented.channel).toBe(DECK_ID);

    // Undo survives the rename: the session never reloaded.
    await first.click('#canvas', 'canvas');
    await first.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => (await session!.fetchDeck(RENAMED)).slides[0].elements.length,
      'undo after the rename did not remove the text box', (count) => count === 2);

    // An edit made straight afterwards, in the other tab, reaches the
    // renamed folder on disk and the presentation.
    await second.call('Page.bringToFront');
    await second.click('button.bar-icon-button[aria-label="Text"]', 'Text');
    await eventually(async () => (await session!.fetchDeck(RENAMED)).slides[0].elements.length,
      'the new text box never reached the server', (count) => count === 3);
    await session.server.flush();
    const saved = parseDeck(JSON.parse(await readFile(join(session.decksRoot, 'talks', 'Big Talk', 'deck.json'), 'utf8')));
    expect(saved.slides[0].elements).toHaveLength(3);
    expect(saved.title).toBe(titleBefore);
    expect(existsSync(join(session.decksRoot, 'talks', 'demo'))).toBe(false);
    await eventually(() => present.evaluate<number>(
      `document.querySelectorAll('#stage .slide [data-element-id]').length`),
    'the presentation did not show the new text box', (count) => count >= 3);
    expect(await present.evaluate<boolean>(PICTURES_LOADED('#stage'))).toBe(true);

    // Assets resolve under the new id, and the old one still answers for
    // anything that loaded before the rename.
    expect((await fetch(`${origin}/decks/${encodeURIComponent(RENAMED)}/assets/pic.png`)).status).toBe(200);
    expect((await fetch(`${origin}/decks/${encodeURIComponent(DECK_ID)}/assets/pic.png`)).status).toBe(200);
  });
});
