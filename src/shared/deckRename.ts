/**
 * Renaming the open deck: its folder gets a new name beside the old one, and
 * the window carries on with the same document, undo history included (the
 * history lives inside the folder).
 */

/**
 * Say what is wrong with `name` as a deck folder's new name.
 *
 * Args:
 *   name: The name as typed, already trimmed.
 *
 * Returns:
 *   A sentence for the rename dialog, or null when the name can be used.
 */
export function deckFolderNameProblem(name: string): string | null {
  if (name === '') return 'Type a name for the presentation.';
  // A slash would move the deck into another folder; Finder shows a colon
  // as a slash, so it is refused for the same reason.
  if (/[/:\\]/.test(name)) return 'A name cannot contain / or :.';
  if (name.startsWith('.')) return 'A name cannot start with a dot, which would hide the folder.';
  if (new TextEncoder().encode(name).length > 255) return 'That name is too long.';
  return null;
}
