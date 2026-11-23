import { deckFolderNameProblem } from '@shared/deckRename.js';
import { button, openDialog } from './templateDialogs.js';

/**
 * Ask for the open deck's new folder name.
 *
 * The name is checked as it is typed, so a name the disk would refuse never
 * reaches the main process; a clash with an existing folder is only known
 * there and comes back as the rename's error.
 *
 * Args:
 *   current: The deck folder's current name, offered selected.
 *
 * Returns:
 *   The trimmed new name, or null when cancelled or left unchanged.
 */
export function showRenameDeckDialog(current: string): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, dialog, actions, finishWith } = openDialog('deck-rename', 'Rename presentation', () => resolve(null));
    const detail = document.createElement('p');
    detail.className = 'template-picker-detail';
    detail.textContent = 'Renames the presentation’s folder where it is. Slides, notes and undo history stay as they are.';
    const field = document.createElement('label');
    field.className = 'field';
    const label = document.createElement('span');
    label.textContent = 'Name';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.spellcheck = false;
    field.append(label, input);
    const problem = document.createElement('p');
    problem.className = 'field-problem';
    problem.setAttribute('role', 'alert');
    problem.hidden = true;
    const cancel = button('Cancel');
    const rename = button('Rename', true);
    actions.append(cancel, rename);
    dialog.append(detail, field, problem, actions);
    document.body.appendChild(overlay);

    const check = (): string | null => {
      const name = input.value.trim();
      const message = deckFolderNameProblem(name);
      problem.textContent = message ?? '';
      problem.hidden = message === null || name === '';
      rename.disabled = message !== null || name === current;
      return message === null ? name : null;
    };
    const submit = () => {
      const name = check();
      if (name === null) return;
      finishWith(() => resolve(name === current ? null : name));
    };
    input.addEventListener('input', check);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    cancel.addEventListener('click', () => finishWith(() => resolve(null)));
    rename.addEventListener('click', submit);
    check();
    input.focus();
    input.select();
  });
}
