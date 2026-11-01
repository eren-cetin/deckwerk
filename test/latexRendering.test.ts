// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { renderSlide } from '../src/renderer/player/render.js';

describe('LaTeX text rendering', () => {
  it('keeps an inline equation in the same text flow as its sentence', () => {
    const slide = emptyDeck().slides[0];
    slide.elements.push({
      id: 'inline-math', type: 'text', x: 0, y: 0, w: 1600, h: 200, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, align: 'left', valign: 'middle',
      html: 'Die Mitternachtsformel lautet $(a+b)^2 = (a^2 + 2ab + b^2)$',
    });
    const rendered = renderSlide(slide, { resolveSrc: (src) => src });
    const body = rendered.querySelector<HTMLElement>('.text-body')!;
    const content = body.querySelector<HTMLElement>(':scope > .text-content')!;

    expect(body.children).toHaveLength(1);
    expect(content.querySelector('.katex')).not.toBeNull();
    expect(content.querySelector('.katex-display')).toBeNull();
    expect(content.textContent).toContain('Die Mitternachtsformel lautet');
  });

  it('renders inline and display equations while preserving escaped dollars', () => {
    const slide = emptyDeck().slides[0];
    slide.elements.push({
      id: 'math', type: 'text', x: 0, y: 0, w: 1000, h: 500, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, align: 'left', valign: 'top',
      html: String.raw`Price: \$5. Inline $E=mc^2$. Display $$\int_0^1 x^2\,dx$$`,
    });
    const rendered = renderSlide(slide, { resolveSrc: (src) => src });
    expect(rendered.querySelectorAll('.katex')).toHaveLength(2);
    expect(rendered.querySelector('.katex-display')).not.toBeNull();
    expect(rendered.textContent).toContain('Price: $5');
  });

  it('shows invalid TeX without crashing the slide', () => {
    const slide = emptyDeck().slides[0];
    slide.elements.push({
      id: 'bad-math', type: 'text', x: 0, y: 0, w: 1000, h: 200, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, align: 'left', valign: 'top',
      html: String.raw`$$\notacommand{oops}$$`,
    });
    expect(() => renderSlide(slide, { resolveSrc: (src) => src })).not.toThrow();
  });
});

/**
 * KaTeX's double-struck font has capitals only, so `\mathbb{1}` used to draw
 * a plain one. The app spells blackboard digits and lowercase letters as their
 * Unicode characters and ships a font that draws them, in every place maths
 * renders: the player, speaker notes, the equation checker and the exported
 * authoring page.
 */
describe('blackboard bold digits and lowercase letters', () => {
  const renderText = (html: string) => {
    const slide = emptyDeck().slides[0];
    slide.elements.push({
      id: 'bb', type: 'text', x: 0, y: 0, w: 1000, h: 200, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, align: 'left', valign: 'top', html,
    });
    return renderSlide(slide, { resolveSrc: (src) => src }).querySelector('.katex-html')!;
  };

  it('draws \\mathbb{1} as the double-struck one, and capitals with KaTeX’s own font', () => {
    const math = renderText(String.raw`$b_t=\mathbb{1}[p_t\ge 0.5],\ x\in\mathbb{R}$`);
    expect(math.textContent).toContain('\u{1D7D9}');
    expect(math.textContent).not.toMatch(/=1\[/);
    expect([...math.querySelectorAll('.mathbb')].map((node) => node.textContent)).toEqual(['R']);
  });

  it('handles the bare argument, lowercase letters and mixed arguments', () => {
    expect(renderText(String.raw`$\mathbb 0$`).textContent).toContain('\u{1D7D8}');
    expect(renderText(String.raw`$\mathbb{a}$`).textContent).toContain('\u{1D552}');
    const mixed = renderText(String.raw`$\mathbb{Z2}$`);
    expect(mixed.textContent).toContain('\u{1D7DA}');
    expect(mixed.querySelector('.mathbb')?.textContent).toBe('Z');
  });

  it('ships a font face for the characters KaTeX has no glyphs for', async () => {
    const { KATEX_CSS } = await import('../src/shared/katexInline.js');
    const face = KATEX_CSS.match(/@font-face\{[^}]*unicode-range:[^}]*1D7D8[^}]*\}/i)?.[0] ?? '';
    expect(face).toContain('KaTeX_Main');
    expect(face).toContain('data:font/woff2;base64,');
  });

  it('renders the same in speaker notes', async () => {
    const { renderNotesMarkdown } = await import('../src/shared/notesMarkdown.js');
    expect(renderNotesMarkdown(String.raw`Indicator $\mathbb{1}[x>0]$`)).toContain('\u{1D7D9}');
  });

  it('renders the same in an exported authoring page opened in a browser', async () => {
    const { JSDOM } = await import('jsdom');
    const { KATEX_PAGE_HTML } = await import('../src/shared/htmlSlides.js');
    const dom = new JSDOM(`<!doctype html><html><head>${KATEX_PAGE_HTML}</head>`
      + String.raw`<body><p>$\mathbb{1}[x]$</p></body></html>`, { runScripts: 'dangerously' });
    // The page renders its maths on DOMContentLoaded, which fires after parsing.
    await new Promise((resolve) => dom.window.addEventListener('DOMContentLoaded', resolve));
    expect(dom.window.document.querySelector('.katex')).not.toBeNull();
    expect(dom.window.document.body.textContent).toContain('\u{1D7D9}');
  });
});
