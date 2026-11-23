import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type CustomLayout, type Deck } from '../src/shared/deck.js';
import { placeholderFor } from '../src/renderer/editor/layoutEditorModel.js';
import { saveTemplate } from '../src/main/templateStore.js';
import { electronBinary, eventually, type Cdp } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * Deck templates in the browser editor, against the same library the desktop
 * app keeps. The Design tab lists the server's templates and applies one as an
 * ordinary transaction — a second tab sees it and Undo takes the slides back —
 * saves the open deck's design under a new name, and the File menu starts a
 * new deck from a template.
 */

const DECK_ID = 'talk';
const PEER_NAME = 'Template Peer';
const MOD = process.platform === 'darwin' ? 4 : 2;

let session: WebEditorSession | null = null;
let templatesDir = '';
let previousTemplatesDir: string | undefined;

afterEach(async () => {
  await session?.close();
  session = null;
  if (previousTemplatesDir === undefined) delete process.env.DECKWERK_TEMPLATES_DIR;
  else process.env.DECKWERK_TEMPLATES_DIR = previousTemplatesDir;
  if (templatesDir) await rm(templatesDir, { recursive: true, force: true });
  templatesDir = '';
});

const status = (cdp: Cdp) => cdp.evaluate<string>('document.getElementById("status")?.textContent ?? ""');
const layoutIds = (deck: Deck) => deck.customLayouts.map((layout) => layout.id);

describe.skipIf(!electronBinary)('deck templates in the collaboration editor', () => {
  it('applies, undoes and saves templates live, and starts a deck from one', {
    timeout: 120_000,
  }, async () => {
    // The server runs in this process, so the library it serves is this one.
    templatesDir = await mkdtemp(join(tmpdir(), 'collab-templates-browser-'));
    previousTemplatesDir = process.env.DECKWERK_TEMPLATES_DIR;
    process.env.DECKWERK_TEMPLATES_DIR = templatesDir;
    const source = emptyDeck('Looped');
    const title: CustomLayout = {
      id: 'lt-title', name: 'Title slide', basedOn: 'title', titleSlide: true,
      background: { color: '#101820', image: null },
      elements: [placeholderFor('title', source.canvas, 1)],
    };
    source.customLayouts = [title];
    source.recentColors = ['#abcdef'];
    await saveTemplate(templatesDir, parseDeck(source), '.kicker { letter-spacing: .2em; }\n', 'Looped');

    session = await launchWebEditor([{
      id: DECK_ID,
      deck: parseDeck({ ...emptyDeck('Talk'), slides: [{ id: 's1', name: 'One', layout: 'title' }] }),
    }]);
    const editor = session.cdp;

    const peerUrl = `${session.origin}/?deck=${encodeURIComponent(DECK_ID)}&name=${encodeURIComponent(PEER_NAME)}`;
    expect(await editor.evaluate<boolean>(`Boolean(window.open(${JSON.stringify(peerUrl)}, 'peer'))`)).toBe(true);
    const peer = await session.connectTarget(
      (target) => target.url.includes(`name=${encodeURIComponent(PEER_NAME)}`),
      'second editor tab',
    );
    await eventually(async () => peer.evaluate<boolean>(`(() => (
      document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${PEER_NAME}`)}) === true
      && Boolean(document.querySelector('#canvas .slide'))
    ))()`), 'the second tab did not connect');
    await editor.call('Page.bringToFront');

    // The Design tab lists the library; pick the template and apply it.
    await editor.click('#side-tabs button[data-panel="themePanel"]', 'Design tab');
    await eventually(async () => editor.evaluate<boolean>(
      'Boolean(document.querySelector(".design-template-list .template-row[data-template-id=\\"looped\\"]"))'),
    'the Design tab did not list the template');
    await editor.click('.design-template-list .template-row[data-template-id="looped"]', 'Looped');
    await editor.clickByText('.template-section button', 'Apply to this deck');
    await eventually(async () => status(editor), 'applying reported nothing',
      (text) => text.includes('Applied template “Looped”'));

    // The server and the other tab both have it: the layouts, the colours,
    // and the stylesheet rules.
    const applied = await eventually(async () => session!.fetchDeck(), 'the server never got the template',
      (deck) => layoutIds(deck).includes('lt-title'));
    expect(applied.recentColors).toContain('#abcdef');
    expect(await session.fetchTheme()).toContain('.kicker');
    await eventually(async () => peer.evaluate<boolean>(`(() => (
      window.store.get().deck.customLayouts.some((layout) => layout.id === 'lt-title')
      && document.querySelector('style[data-role="deck-theme"]')?.textContent.includes('.kicker') === true
    ))()`), 'the second tab did not see the template');

    // Undo is the applier's own, and puts the slides' design back for everyone.
    await editor.click('#canvas', 'canvas');
    await editor.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => session!.fetchDeck(), 'undo did not reach the server',
      (deck) => !layoutIds(deck).includes('lt-title'));
    await eventually(async () => peer.evaluate<boolean>(
      `!window.store.get().deck.customLayouts.some((layout) => layout.id === 'lt-title')`),
    'the second tab did not see the undo');

    // Save this deck's design under a new name, from the same section.
    await editor.clickByText('.template-section button', 'Save this design as a template…');
    await eventually(async () => editor.evaluate<boolean>('Boolean(document.querySelector(".template-name input"))'),
      'no name dialog');
    await editor.evaluate(`(() => {
      const input = document.querySelector('.template-name input');
      input.value = 'Talk design';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await editor.click('.template-name button.primary', 'Save template');
    await eventually(async () => existsSync(join(templatesDir, 'talk-design', 'template.json')),
      'Save as Template wrote nothing');
    const saved = JSON.parse(await readFile(join(templatesDir, 'talk-design', 'template.json'), 'utf8'));
    expect(saved.source).toBe('Talk');
    expect(saved.css).toContain('.kicker');
    await eventually(async () => editor.evaluate<string[]>(
      '[...document.querySelectorAll(".design-template-list .template-row")].map((row) => row.dataset.templateId)'),
    'the Design tab did not list the new template', (ids) => ids.includes('talk-design') && ids.includes('looped'));

    // File › New from Template…: pick it, name the deck, and land in it.
    await editor.evaluate(`(() => {
      window.prompt = () => 'From template';
      return true;
    })()`);
    await editor.evaluate(`([...document.querySelectorAll('.toolbar-compact-file-action .shape-menu-trigger')][0].click(), true)`);
    await editor.evaluate(`([...document.querySelectorAll('.shape-menu .shape-menu-item')]
      .find((row) => row.textContent === 'New from Template…').click(), true)`);
    await eventually(async () => editor.evaluate<boolean>(
      'Boolean(document.querySelector(".template-picker .template-row[data-template-id=\\"looped\\"]"))'),
    'the picker did not list the template');
    await editor.click('.template-picker .template-row[data-template-id="looped"]', 'Looped');
    await editor.click('.template-picker button.primary', 'Create deck…');
    const createdDir = join(session.decksRoot, 'From template');
    await eventually(async () => existsSync(join(createdDir, 'deck.json')), 'no deck was created');
    const created = parseDeck(JSON.parse(await readFile(join(createdDir, 'deck.json'), 'utf8')));
    expect(created.slides[0].layout).toBe('lt-title');
    expect(await readFile(join(createdDir, 'theme.css'), 'utf8')).toContain('.kicker');
    await eventually(async () => editor.evaluate<string>('location.search'), 'the new deck did not open',
      (search) => new URLSearchParams(search).get('deck') === 'From template');
  });
});
