import { afterEach, describe, expect, it } from 'vitest';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { emptyDeck } from '../src/shared/deck.js';
import { defaultLayoutMasters } from '../src/shared/layoutMasters.js';
import { electronBinary, eventually } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * A layout placeholder's words are prompt copy: every slide replaces them
 * with its own text. Double-clicking a placeholder selects that prompt, and a
 * font weight typed then used to be given to the selected characters — it
 * showed in the layout editor, was saved inside the prompt, and reached no
 * slide. It has to style the placeholder itself, which is what slides inherit.
 */

const TITLE = '.layout-editor-canvas .slide-layer .role-title';

let session: WebEditorSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe.skipIf(!electronBinary)('typography of a layout placeholder being edited', () => {
  it('gives a weight typed with the prompt selected to the placeholder and its slides', {
    timeout: 120_000,
  }, async () => {
    // One slide on the built-in Title + Body layout, its title written.
    const deck = emptyDeck('Demo');
    deck.layoutMasters = defaultLayoutMasters();
    applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
    for (const element of deck.slides[0].elements) {
      if (element.type !== 'text') continue;

      element.html = `Authored ${element.layoutPlaceholder}`;
      element.class = element.class.filter((name) => name !== 'placeholder');
    }

    session = await launchWebEditor([{ id: 'demo', deck }]);
    const cdp = session.cdp;
    const slideTitle = async () => (await session!.fetchDeck()).slides[0].elements
      .find((element) => element.type === 'text' && element.layoutPlaceholder === 'title');
    expect((await slideTitle())?.style['font-weight']).toBeUndefined();

    await cdp.evaluate(`([...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim().startsWith('Edit layouts')).click(), true)`);
    await eventually(() => cdp.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(TITLE)}))`),
      'the layout editor never showed the title placeholder', Boolean);

    // Real input: the double-click that enters the prompt and selects in it.
    await cdp.doubleClickText(`${TITLE} .text-content`, 'title placeholder');
    await eventually(() => cdp.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(`${TITLE} .text-content`)})?.isContentEditable ?? false`),
    'the placeholder never entered text editing', Boolean);

    const weightField = `(() => [...document.querySelectorAll('.layout-editor-inspector label')]
      .find((label) => label.textContent.trim().startsWith('Font weight')).querySelector('input'))()`;
    await cdp.evaluate(`(${weightField}.focus(), ${weightField}.select(), true)`);
    await cdp.typeKeys('300');
    await cdp.key('Enter', 13);
    await eventually(() => cdp.evaluate<string>(`document.querySelector(${JSON.stringify(TITLE)}).style.fontWeight`),
      'the weight was not given to the placeholder itself', (weight) => weight === '300');

    await cdp.clickByText('.layout-editor-actions button', 'Done');
    await eventually(async () => (await slideTitle())?.style['font-weight'],
      'the slide on that layout never took the new weight', (weight) => weight === '300');
    const master = (await session.fetchDeck()).layoutMasters!.standard.elements
      .find((element) => element.type === 'text' && element.layoutPlaceholder === 'title');
    expect(master?.style['font-weight']).toBe('300');
  });
});
