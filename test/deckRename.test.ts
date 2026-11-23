import { describe, expect, it } from 'vitest';
import { deckFolderNameProblem } from '../src/shared/deckRename.js';

describe('deck folder names', () => {
  it('accepts an ordinary name, spaces and accents included', () => {
    expect(deckFolderNameProblem('Doctoral Day — Zürich')).toBeNull();
  });

  it('refuses names that would move, hide or overflow the folder', () => {
    expect(deckFolderNameProblem('')).toMatch(/Type a name/);
    expect(deckFolderNameProblem('talks/new')).toMatch(/cannot contain/);
    expect(deckFolderNameProblem('a:b')).toMatch(/cannot contain/);
    expect(deckFolderNameProblem('.hidden')).toMatch(/dot/);
    expect(deckFolderNameProblem('é'.repeat(128))).toMatch(/too long/);
  });
});
