// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fontFaceUsed,
  loadedFontFaces,
  normalizeFontFamily,
  pictureSvg,
  preferredFontSource,
  replaceCssUrls,
  snapshotDocument,
  splitCssList,
} from '../src/renderer/collab/rasterize.js';

/**
 * The pure half of the browser client's Copy as Image: everything an SVG
 * `foreignObject` needs inlined, and what it must leave out. The drawing
 * itself is covered in a real browser by collabCopyImageBrowser.test.ts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('replaceCssUrls', () => {
  it('resolves every quoting style against the base and keeps data and fragment URLs', async () => {
    const seen: string[] = [];
    const css = [
      '@font-face { src: url("fonts/a.woff2") format("woff2"); }',
      ".b { background: url('../img/b.png'); }",
      '.c { mask: url(c.svg#m); filter: url(#blur); }',
      '.d { background: url(data:image/png;base64,AAAA); }',
      '.e { background: url("fonts/a.woff2"); }',
    ].join('\n');
    const out = await replaceCssUrls(css, 'http://host/app/x.css', async (absolute) => {
      seen.push(absolute);
      return absolute.endsWith('.svg#m') ? null : `data:${absolute.split('/').pop()}`;
    });
    expect(seen.sort()).toEqual([
      'http://host/app/c.svg#m',
      'http://host/app/fonts/a.woff2',
      'http://host/img/b.png',
    ]);
    expect(out).toContain('src: url("data:a.woff2") format("woff2")');
    expect(out).toContain('background: url("data:b.png")');
    expect(out).toContain('url(c.svg#m)');
    expect(out).toContain('url(#blur)');
    expect(out).toContain('url(data:image/png;base64,AAAA)');
    expect(out).toContain('.e { background: url("data:a.woff2"); }');
  });
});

describe('font selection', () => {
  it('splits a src list only at top-level commas', () => {
    expect(splitCssList('url("a,b.woff2") format("woff2"), local(X), url(c.woff)'))
      .toEqual(['url("a,b.woff2") format("woff2")', 'local(X)', 'url(c.woff)']);
  });

  it('prefers WOFF2, then the first downloadable source, never local()', () => {
    expect(preferredFontSource('url(a.ttf) format("truetype"), url(a.woff2) format("woff2")'))
      .toBe('url(a.woff2) format("woff2")');
    expect(preferredFontSource('local(Arial), url(a.woff) format("woff"), url(a.ttf)'))
      .toBe('url(a.woff) format("woff")');
    expect(preferredFontSource('local(Arial)')).toBeNull();
  });

  it('keeps only faces the page loaded, by family and unicode range', () => {
    const loaded = loadedFontFaces([
      { family: '"KaTeX_Main"', status: 'loaded', unicodeRange: 'U+0-10FFFF' },
      { family: 'Inter', status: 'loaded', unicodeRange: 'U+0000-00FF' },
      { family: 'Unused', status: 'unloaded', unicodeRange: 'U+0-10FFFF' },
    ] as unknown as FontFace[]);
    expect(normalizeFontFamily(" 'KaTeX_Main' ")).toBe('katex_main');
    expect(fontFaceUsed('KaTeX_Main', '', loaded)).toBe(true);
    expect(fontFaceUsed('"Inter"', 'U+0000-00FF', loaded)).toBe(true);
    // A Google Fonts subset for a script the page never drew.
    expect(fontFaceUsed('Inter', 'U+0400-045F', loaded)).toBe(false);
    expect(fontFaceUsed('Unused', '', loaded)).toBe(false);
    expect(fontFaceUsed('KaTeX_AMS', '', loaded)).toBe(false);
  });
});

describe('snapshotDocument', () => {
  it('inlines pictures, flattens shadow content and leaves out what cannot be drawn', async () => {
    // jsdom's FileReader reads only jsdom's own Blob, not the one a Node Response makes.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      blob: async () => new Blob([`bytes of ${url}`], { type: 'image/png' }),
    })));
    document.documentElement.className = 'copy-image';
    document.head.innerHTML = '<style>.box { background: url(assets/bg.png); }</style><script>1</script>';
    document.body.innerHTML = [
      '<div id="pages">',
      '<img id="pic" src="/decks/d/assets/a.png" srcset="x.png 2x">',
      '<div id="styled" style="background-image: url(&quot;/decks/d/assets/b.png&quot;)"></div>',
      '<embed src="/decks/d/assets/handout.pdf">',
      '<div class="web-body"><iframe src="/decks/d/page.html"></iframe></div>',
      '<div id="host"></div>',
      '</div>',
    ].join('');
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>:host { display: block } p { color: red }</style><p>inside</p>';

    const { svg, skipped } = await snapshotDocument(document, 300, 200);
    expect(skipped).toBe(2);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="300" height="200"/);
    expect(svg).toContain('<foreignObject x="0" y="0" width="300" height="200"><html xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg).toContain('class="copy-image"');
    expect(svg).not.toContain('<embed');
    expect(svg).not.toContain('<iframe');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('srcset');
    // Every URL the picture loads is now a data URL.
    expect(svg).not.toMatch(/(?:src="|url\(&quot;|url\(")\/decks/);
    expect(svg).toMatch(/<img id="pic" src="data:image\/png;base64,/);
    expect(svg).toMatch(/\.box \{ ?background: url\("data:image\/png;base64,/);
    // The shadow tree is ordinary content whose styles apply only below its host.
    expect(svg).toContain('data-picture-scope="0"');
    expect(svg).toContain('<p>inside</p>');
    expect(svg).toContain('@scope ([data-picture-scope="0"])');
    expect(svg).toContain(':scope { display: block }');
  });

  it('wraps the page in an SVG of the requested size', () => {
    expect(pictureSvg('<html/>', 12, 34)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="34" viewBox="0 0 12 34">'
      + '<foreignObject x="0" y="0" width="12" height="34"><html/></foreignObject></svg>',
    );
  });
});
