(() => {
  if (typeof window.HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) return;

  let dialogIndex = 0;
  const recoverableDialogs = [];

  document.querySelectorAll('details.finance-fee-adjustment-details, details.finance-fee-comment-details, details.finance-fee-reversal-details').forEach((disclosure) => {
    const form = disclosure.querySelector(':scope > form[data-fee-action-dialog]');
    const opener = disclosure.querySelector(':scope > summary');
    if (!form || !opener) return;

    const openOnLoad = disclosure.open;
    const title = form.dataset.feeActionDialog || opener.textContent.trim();
    const dialog = document.createElement('dialog');
    const currentDialogIndex = dialogIndex++;
    const titleId = `finance-fee-action-title-${currentDialogIndex}`;
    dialog.className = 'finance-fee-action-dialog';
    dialog.id = `finance-fee-action-dialog-${currentDialogIndex}`;
    dialog.setAttribute('aria-labelledby', titleId);
    opener.setAttribute('aria-haspopup', 'dialog');
    opener.setAttribute('aria-controls', dialog.id);

    const header = document.createElement('div');
    header.className = 'finance-fee-action-dialog__header';
    const heading = document.createElement('h2');
    heading.id = titleId;
    heading.textContent = title;
    const cancel = document.createElement('button');
    cancel.className = 'button button--secondary';
    cancel.type = 'button';
    cancel.textContent = 'Close';
    cancel.addEventListener('click', () => dialog.close());
    header.append(heading, cancel);

    const actions = document.createElement('div');
    actions.className = 'finance-fee-action-dialog__actions';
    actions.append(cancel.cloneNode(true));
    actions.firstElementChild.textContent = 'Cancel';
    actions.firstElementChild.addEventListener('click', () => dialog.close());

    dialog.append(header, form, actions);
    document.body.append(dialog);

    const openDialog = () => {
      if (dialog.open) return;
      disclosure.open = false;
      dialog.showModal();
      document.body.classList.add('finance-fee-action-dialog-open');
      form.querySelector('input:not([type="hidden"]), textarea, select')?.focus();
    };
    opener.addEventListener('click', (event) => {
      event.preventDefault();
      openDialog();
    });
    dialog.addEventListener('close', () => {
      document.body.classList.remove('finance-fee-action-dialog-open');
      if (opener.isConnected) opener.focus();
    });

    if (openOnLoad) {
      disclosure.open = false;
      recoverableDialogs.push({ dialog, form });
    }
  });

  const recovery = recoverableDialogs[0];
  if (recovery) {
    recovery.dialog.showModal();
    document.body.classList.add('finance-fee-action-dialog-open');
    recovery.form.querySelector('input:not([type="hidden"]), textarea, select, button[type="submit"]')?.focus();
  }
})();
