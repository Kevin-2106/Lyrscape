export interface ConfirmOptions {
  title: string; body: string; accept: string; danger?: boolean;
  /** Label / value rows shown under the body, e.g. what a package contains. */
  details?: [string, string][];
  /** A highlighted caution line. */
  warning?: string;
}

/** Modal confirmation on the native <dialog>: focus trap, Esc and backdrop come from the platform. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.innerHTML = `<form method="dialog"><h2></h2><p class="dialog-body"></p><dl class="dialog-details" hidden></dl><p class="dialog-warning" hidden></p><div class="dialog-actions"><button class="button-secondary" value="cancel" formnovalidate>取消</button><button class="${options.danger ? 'button-danger' : 'button-primary'}" value="accept"></button></div></form>`;
    dialog.querySelector('h2')!.textContent = options.title;
    dialog.querySelector('.dialog-body')!.textContent = options.body;
    const details = dialog.querySelector<HTMLElement>('.dialog-details')!;
    for (const [label, value] of options.details ?? []) {
      const term = document.createElement('dt'), data = document.createElement('dd');
      term.textContent = label; data.textContent = value; details.append(term, data);
    }
    details.hidden = !options.details?.length;
    const warning = dialog.querySelector<HTMLElement>('.dialog-warning')!;
    warning.textContent = options.warning ?? ''; warning.hidden = !options.warning;
    const accept = dialog.querySelector<HTMLButtonElement>('button[value="accept"]')!;
    accept.textContent = options.accept;
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'accept'); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button[value="cancel"]')!.focus();
  });
}
