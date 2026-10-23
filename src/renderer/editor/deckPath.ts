/**
 * How the toolbar writes a deck's folder: the folders leading to it, with
 * the home folder shortened to ~, and the folder's own name apart, so the
 * name can stay whole while a long lead-in is trimmed.
 */
export function deckPathParts(dir: string | null, home = ''): { parent: string; name: string } {
  if (!dir) return { parent: '', name: '' };
  const trimmed = dir.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = trimmed.slice(cut + 1);
  let parent = cut >= 0 ? trimmed.slice(0, cut + 1) : '';
  const homeDir = home.replace(/[\\/]+$/, '');
  if (homeDir && (parent === `${homeDir}/` || parent === `${homeDir}\\` || parent.startsWith(`${homeDir}/`) || parent.startsWith(`${homeDir}\\`))) {
    parent = `~${parent.slice(homeDir.length)}`;
  }
  return { parent, name };
}
