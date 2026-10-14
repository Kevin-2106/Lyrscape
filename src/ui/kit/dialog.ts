export interface ConfirmOptions { title: string; body: string; accept: string; danger?: boolean }

/** Modal confirmation on the native <dialog>: focus trap, Esc and backdrop come from the platform. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.innerHTML = `<form method="dialog"><h2></h2><p></p><div class="dialog-actions"><button class="button-secondary" value="cancel" formnovalidate>取消</button><button class="${options.danger ? 'button-danger' : 'button-primary'}" value="accept"></button></div></form>`;
    dialog.querySelector('h2')!.textContent = options.title;
    dialog.querySelector('p')!.textContent = options.body;
    const accept = dialog.querySelector<HTMLButtonElement>('button[value="accept"]')!;
    accept.textContent = options.accept;
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'accept'); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button[value="cancel"]')!.focus();
  });
}
