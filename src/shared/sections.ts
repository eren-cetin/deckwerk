import type { Deck, Slide } from './deck.js';
import { makeId } from './geometry.js';

/**
 * Sections: named runs of slides, folded together in the slide rail.
 *
 * The deck lists the sections by id and name; each slide names the section it
 * belongs to. A slide that names none -- one just added, duplicated, pasted or
 * written by an agent -- belongs to the section of the slide before it, so it
 * lands in the section it was put into without anyone filing it there. Slides
 * before the first section belong to none and show without a header.
 *
 * Membership travels with a slide: dragged elsewhere it joins the section it
 * is dropped into, and the section it left keeps the rest of its slides.
 */

export interface DeckSection {
  id: string;
  name: string;
}

/** One header's worth of slides: a section, or the unsectioned lead-in. */
export interface SectionRun {
  section: DeckSection | null;
  /** First and last slide index, inclusive. */
  start: number;
  end: number;
}

type Sectioned = Pick<Deck, 'sections'> & { slides: Array<Pick<Slide, 'id' | 'section'>> };

/** The section each slide is in, by index: its own, or the one it inherits. */
export function slideSections(deck: Sectioned): Array<string | null> {
  const known = new Set(deck.sections.map((section) => section.id));
  const out: Array<string | null> = [];
  let current: string | null = null;
  for (const slide of deck.slides) {
    if (slide.section && known.has(slide.section)) current = slide.section;
    out.push(current);
  }
  return out;
}

/** The slides grouped under their headers, in deck order. */
export function sectionRuns(deck: Sectioned): SectionRun[] {
  const byId = new Map(deck.sections.map((section) => [section.id, section]));
  const runs: SectionRun[] = [];
  slideSections(deck).forEach((id, index) => {
    const last = runs[runs.length - 1];
    if (last && (last.section?.id ?? null) === id) last.end = index;
    else runs.push({ section: id ? byId.get(id)! : null, start: index, end: index });
  });
  return runs;
}

/**
 * Write every slide's effective section onto it, so a later change to the
 * slides around one (a delete, a move) cannot quietly move it into another.
 */
export function pinSections(deck: Sectioned): void {
  const sections = slideSections(deck);
  deck.slides.forEach((slide, index) => {
    const id = sections[index];
    if (id) slide.section = id;
    else delete slide.section;
  });
}

/** Forget sections no slide is in any more. */
export function pruneSections(deck: Sectioned): void {
  const used = new Set(slideSections(deck));
  deck.sections = deck.sections.filter((section) => used.has(section.id));
}

/**
 * Start a new section at slide `at`, running to the end of the section it
 * was in. With no sections yet and slides before `at`, those get a "Default
 * section" of their own, so every slide has a header to fold under.
 * Returns the new section's id.
 */
export function addSection(deck: Sectioned, at: number, name: string): string {
  pinSections(deck);
  const sections = slideSections(deck);
  const id = makeId('section');
  if (deck.sections.length === 0 && at > 0) {
    const lead = makeId('section');
    deck.sections.push({ id: lead, name: 'Default section' });
    for (let index = 0; index < at; index++) deck.slides[index].section = lead;
  }
  const from = sections[at] ?? null;
  for (let index = at; index < deck.slides.length && (sections[index] ?? null) === from; index++) {
    deck.slides[index].section = id;
  }
  // Listed in slide order, so the deck file reads like the rail.
  const before = new Set(slideSections(deck).slice(0, at));
  const insertAt = deck.sections.filter((section) => before.has(section.id)).length;
  deck.sections.splice(insertAt, 0, { id, name });
  return id;
}

export function renameSection(deck: Sectioned, id: string, name: string): void {
  const section = deck.sections.find((candidate) => candidate.id === id);
  if (section) section.name = name.trim() || section.name;
}

/**
 * Remove a section but keep its slides: they join the section before it, or,
 * for the first section, the one after it.
 */
export function removeSection(deck: Sectioned, id: string): void {
  pinSections(deck);
  const sections = slideSections(deck);
  const first = sections.indexOf(id);
  if (first === -1) {
    deck.sections = deck.sections.filter((section) => section.id !== id);
    return;
  }
  const before = first > 0 ? sections[first - 1] : null;
  const after = sections.find((candidate, index) => index > first && candidate !== id) ?? null;
  const heir = before ?? after;
  deck.slides.forEach((slide, index) => {
    if (sections[index] !== id) return;
    if (heir) slide.section = heir;
    else delete slide.section;
  });
  deck.sections = deck.sections.filter((section) => section.id !== id);
}

/**
 * Put moved slides into the section they now sit in. `section` is the one
 * the drop chose; null keeps the slide before them deciding.
 */
export function adoptSection(deck: Sectioned, slideIds: ReadonlySet<string>, section: string | null): void {
  for (const slide of deck.slides) {
    if (!slideIds.has(slide.id)) continue;
    if (section) slide.section = section;
    else delete slide.section;
  }
}
