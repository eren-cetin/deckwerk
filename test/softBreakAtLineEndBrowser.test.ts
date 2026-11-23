import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import {
  CONTENT,
  startListEditingSession,
  type ListEditingSession,
} from './support/listEditingSession.js';

/**
 * Shift+Return at the very end of a line makes a new, empty line in it.
 *
 * Reported: in a bullet, Shift+Return (to get a new line without a new
 * bullet) showed the new line while typing, and it vanished as soon as the
 * edit ended. Chromium keeps a trailing line break visible with a second,
 * placeholder <br>; the saved markup kept only one, and a lone <br> at the end
 * of a block draws no line at all.
 */
const SHIFT = 8;

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession('soft-break-line-end', 'Soft Break');
  session = started.session;
  close = started.close;
}, 120_000);

afterAll(async () => {
  await close?.();
  close = null;
});

/** A real Shift+Return: the key carries its "\r", which is what makes Chromium break the line. */
async function shiftReturn(): Promise<void> {
  for (const type of ['keyDown', 'keyUp']) {
    await session.cdp.call('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', modifiers: SHIFT,
      text: type === 'keyDown' ? '\r' : undefined,
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
  }
}

/** Lines block `selector` occupies in the box, from its height and line height. */
const linesOf = (selector: string) => session.cdp.evaluate<number>(`(() => {
  const block = document.querySelector(${JSON.stringify(`${CONTENT} ${selector}`)});
  const lineHeight = Number.parseFloat(getComputedStyle(block).lineHeight);
  // offsetHeight, not the client rect: the canvas is drawn scaled.
  return Math.round(block.offsetHeight / lineHeight);
})()`);

const LINES = [
  { name: 'bullet', html: '<ul><li>alpha</li></ul><p>after</p>', block: 'li' },
  { name: 'paragraph', html: '<p>alpha</p><p>after</p>', block: 'p' },
] as const;

describe.skipIf(!electronBinary)('Shift+Return at the end of a line', () => {
  for (const line of LINES) {
    it(`keeps the new empty line of a ${line.name} after editing ends`, { timeout: 120_000 }, async () => {
      await session.reset(line.html);
      await session.edit();
      await session.caretIn('alpha', 'end');
      await shiftReturn();
      await wait(80);
      expect(await linesOf(`${line.block}:first-of-type`), `the break made no line while typing: ${await session.markup()}`).toBe(2);

      await session.cdp.key('Escape', 27);
      await eventually(() => session.cdp.evaluate<boolean>(
        `!document.querySelector('#canvas .text-element.editing, #canvas .editing')`), 'the edit never ended', Boolean);
      expect(await linesOf(`${line.block}:first-of-type`), `the new line vanished: ${await session.markup()}`).toBe(2);
      // And a reload of what was stored draws it too.
      const stored = await session.persistedOutline();
      expect(stored.length).toBeGreaterThan(0);
      await session.reset(await session.cdp.evaluate<string>(`fetch(location.origin + '/api/deck?deck=soft-break-line-end')
        .then((r) => r.json()).then((deck) => deck.slides[0].elements.find((e) => e.id === 'list-editing-text').html)`));
      expect(await linesOf(`${line.block}:first-of-type`), `the stored markup draws no new line: ${await session.markup()}`).toBe(2);
    });
  }
});
