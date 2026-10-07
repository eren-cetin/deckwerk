import { describe, expect, it } from 'vitest';
import {
  addSection,
  adoptSection,
  pinSections,
  pruneSections,
  removeSection,
  renameSection,
  sectionRuns,
  slideSections,
} from '../src/shared/sections.js';

/**
 * Sections are names on runs of slides; these are the rules the rail, undo
 * and the agent outline all read them by.
 */

type Deck = { sections: Array<{ id: string; name: string }>; slides: Array<{ id: string; section?: string }> };

const deck = (count: number): Deck => ({
  sections: [],
  slides: Array.from({ length: count }, (_, index) => ({ id: `s${index + 1}` })),
});

const runs = (target: Deck) => sectionRuns(target)
  .map((run) => [run.section?.name ?? null, run.start, run.end]);

describe('which section a slide is in', () => {
  it('inherits from the slide before it, and ignores sections the deck lacks', () => {
    const target = deck(4);
    target.sections = [{ id: 'a', name: 'Intro' }];
    target.slides[1].section = 'a';
    target.slides[3].section = 'gone';
    expect(slideSections(target)).toEqual([null, 'a', 'a', 'a']);
    expect(runs(target)).toEqual([[null, 0, 0], ['Intro', 1, 3]]);
  });
});

describe('adding, naming and removing sections', () => {
  it('gives the slides before the first section a default section of their own', () => {
    const target = deck(5);
    addSection(target, 2, 'Method');
    expect(runs(target)).toEqual([['Default section', 0, 1], ['Method', 2, 4]]);
    expect(target.sections.map((section) => section.name)).toEqual(['Default section', 'Method']);
  });

  it('splits the section a new one starts in, and lists sections in slide order', () => {
    const target = deck(6);
    addSection(target, 0, 'Intro');
    addSection(target, 4, 'Results');
    addSection(target, 2, 'Method');
    expect(runs(target)).toEqual([['Intro', 0, 1], ['Method', 2, 3], ['Results', 4, 5]]);
    expect(target.sections.map((section) => section.name)).toEqual(['Intro', 'Method', 'Results']);
  });

  it('renames, keeping the old name for an empty one', () => {
    const target = deck(2);
    const id = addSection(target, 0, 'Intro');
    renameSection(target, id, '  Opening ');
    expect(target.sections[0].name).toBe('Opening');
    renameSection(target, id, '   ');
    expect(target.sections[0].name).toBe('Opening');
  });

  it('removes a section but keeps its slides in the one before, or after for the first', () => {
    const target = deck(6);
    const intro = addSection(target, 0, 'Intro');
    const method = addSection(target, 2, 'Method');
    addSection(target, 4, 'Results');
    removeSection(target, method);
    expect(runs(target)).toEqual([['Intro', 0, 3], ['Results', 4, 5]]);
    removeSection(target, intro);
    expect(runs(target)).toEqual([['Results', 0, 5]]);
  });
});

describe('membership through edits', () => {
  it('keeps a section when its first slide is deleted', () => {
    const target = deck(5);
    addSection(target, 0, 'Intro');
    addSection(target, 2, 'Method');
    pinSections(target);
    target.slides.splice(2, 1);
    pruneSections(target);
    expect(runs(target)).toEqual([['Intro', 0, 1], ['Method', 2, 3]]);
  });

  it('forgets a section whose slides are all gone', () => {
    const target = deck(3);
    addSection(target, 0, 'Intro');
    addSection(target, 2, 'Outro');
    target.slides.pop();
    pruneSections(target);
    expect(target.sections.map((section) => section.name)).toEqual(['Intro']);
  });

  it('moves a slide into the section it is dropped in, leaving its old one whole', () => {
    const target = deck(4);
    const intro = addSection(target, 0, 'Intro');
    addSection(target, 2, 'Method');
    pinSections(target);
    // s1 moves to the end, into Method.
    target.slides.push(target.slides.shift()!);
    adoptSection(target, new Set(['s1']), slideSections(target)[2]);
    expect(runs(target)).toEqual([['Intro', 0, 0], ['Method', 1, 3]]);
    expect(target.slides[0].section).toBe(intro);
  });
});
