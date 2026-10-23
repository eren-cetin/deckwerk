import { describe, expect, it } from 'vitest';
import { deckPathParts } from '../src/renderer/editor/deckPath.js';

/** How the toolbar writes the open deck's folder. */
describe('the deck path in the toolbar', () => {
  it('splits off the folder’s own name and shortens home to ~', () => {
    expect(deckPathParts('/Users/eren/Desktop/PhD/Talk', '/Users/eren'))
      .toEqual({ parent: '~/Desktop/PhD/', name: 'Talk' });
    expect(deckPathParts('/Users/eren/Talk/', '/Users/eren/')).toEqual({ parent: '~/', name: 'Talk' });
  });

  it('leaves a path outside home whole, and a home-like prefix alone', () => {
    expect(deckPathParts('/Volumes/USB/Talk', '/Users/eren')).toEqual({ parent: '/Volumes/USB/', name: 'Talk' });
    expect(deckPathParts('/Users/erenx/Talk', '/Users/eren')).toEqual({ parent: '/Users/erenx/', name: 'Talk' });
  });

  it('reads Windows paths, and shows nothing with no deck open', () => {
    expect(deckPathParts('C:\\Users\\eren\\Talk', 'C:\\Users\\eren')).toEqual({ parent: '~\\', name: 'Talk' });
    expect(deckPathParts(null, '/Users/eren')).toEqual({ parent: '', name: '' });
  });
});
