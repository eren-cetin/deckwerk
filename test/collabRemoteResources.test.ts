import { describe, expect, it } from 'vitest';
import { blockRemoteResources } from '../src/server/collabServer.js';

/**
 * A page an agent applies through the collab server is stripped of anything
 * that would load from the network. A link is not a load, and used to lose
 * its address anyway: the check for "is this href on an anchor" looked at the
 * attribute text, which never starts with `<a`.
 */
describe('blocking remote resources in applied pages', () => {
  it('keeps the address of a link, whatever else the anchor carries', () => {
    const page = '<p>See <a href="https://arxiv.org/html/2410.06940">x</a> and '
      + "<a class=\"ref\" target='_blank' href='http://example.org/a?b=1&amp;c=2'>y</a>.</p>";
    expect(blockRemoteResources(page)).toEqual({ html: page, blocked: [] });
  });

  it('still drops remote media, stylesheets and SVG images', () => {
    const { html, blocked } = blockRemoteResources(
      '<img src="https://cdn.example/a.png" alt="A"><video poster="https://cdn.example/p.jpg"></video>'
      + '<link rel="stylesheet" href="https://fonts.example/css"><svg><image href="https://cdn.example/b.svg"/></svg>'
      + '<a href="https://ok.example/">kept</a><img src="assets/local.png">',
    );
    expect(blocked).toEqual([
      'https://cdn.example/a.png', 'https://cdn.example/p.jpg',
      'https://fonts.example/css', 'https://cdn.example/b.svg',
    ]);
    expect(html).toBe('<img alt="A"><video></video><link rel="stylesheet"><svg><image/></svg>'
      + '<a href="https://ok.example/">kept</a><img src="assets/local.png">');
  });

  it('judges each attribute by its own tag, and leaves text and attribute values alone', () => {
    const { html, blocked } = blockRemoteResources(
      '<a href="https://ok.example/"><img src="https://cdn.example/in-link.png"></a>'
      + '<p title="a > b">href="https://in.text/" is prose</p>'
      + '<div data-note=\'src="https://in.value/"\'>x</div>',
    );
    expect(blocked).toEqual(['https://cdn.example/in-link.png']);
    expect(html).toBe('<a href="https://ok.example/"><img></a>'
      + '<p title="a > b">href="https://in.text/" is prose</p>'
      + '<div data-note=\'src="https://in.value/"\'>x</div>');
  });
});
