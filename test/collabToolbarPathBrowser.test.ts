import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { electronBinary, eventually } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * The browser toolbar names the open deck the way the desktop app does: the
 * folders leading to it, then its own folder, with a menu behind it. File ›
 * New Window opens the picker in a new tab, since a page cannot place one.
 */

const DECK_ID = 'talks/demo';

let session: WebEditorSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe.skipIf(!electronBinary)('deck path in the collaboration toolbar', () => {
  it('shows a nested deck’s folders, offers its menu, and opens New Window on the picker', {
    timeout: 120_000,
  }, async () => {
    session = await launchWebEditor([{ id: DECK_ID, deck: emptyDeck('Demo') }]);
    const cdp = session.cdp;

    const label = await cdp.evaluate<{ parent: string; folder: string; parentHidden: boolean }>(`(() => {
      const button = document.querySelector('button.bar-deck-name');
      return {
        parent: button.querySelector('.bar-deck-parent > bdi').textContent,
        folder: button.querySelector('.bar-deck-folder').textContent,
        parentHidden: button.querySelector('.bar-deck-parent').hidden,
      };
    })()`);
    expect(label).toEqual({ parent: 'talks/', folder: 'demo', parentHidden: false });

    await cdp.click('button.bar-deck-name', 'deck folder');
    const rows = await eventually(async () => cdp.evaluate<string[]>(
      `[...document.querySelectorAll('#ctx-menu button')].map((row) => row.textContent)`),
    'the deck folder menu never opened', (found) => found.length > 0);
    expect(rows).toEqual(['Copy link', 'Open folder…', 'Rename Folder…', 'Rename Title…']);
    await cdp.evaluate(`([...document.querySelectorAll('#ctx-menu button')]
      .find((row) => row.textContent === 'Open folder…').click(), true)`);
    const crumbs = await eventually(async () => cdp.evaluate<string>(
      `document.querySelector('.deck-picker-trail')?.textContent ?? ''`),
    'Open folder… did not open the picker', (text) => text.includes('talks'));
    expect(crumbs).toContain('talks');
    await cdp.key('Escape', 27);

    // The compact File menu holds New Window; drive it through its action.
    await cdp.evaluate(`(() => {
      window.__opened = [];
      window.open = (url, target) => { window.__opened.push([url, target]); return null; };
      return true;
    })()`);
    await cdp.evaluate(`([...document.querySelectorAll('.toolbar-compact-file-action .shape-menu-trigger')][0].click(), true)`);
    await cdp.evaluate(`([...document.querySelectorAll('.shape-menu .shape-menu-item')]
      .find((row) => row.textContent === 'New Window').click(), true)`);
    expect(await cdp.evaluate<string[][]>('window.__opened')).toEqual([['/', '_blank']]);
  });
});
