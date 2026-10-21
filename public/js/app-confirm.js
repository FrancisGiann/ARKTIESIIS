'use strict';

(function attach(root, factory) {
  const initialize = factory();
  if (typeof module === 'object' && module.exports) module.exports = { initialize };
  if (root?.document && root?.window) initialize({ document: root.document, window: root.window });
})(typeof globalThis === 'object' ? globalThis : this, function makeInitializer() {
  function initialize({ document, window } = {}) {
    if (!document || !window) return null;

    let activeDialog = null;

    function announceUnavailable(message = 'This action was canceled because a confirmation could not be opened. Your changes are still here.') {
      if (!document.body?.append || typeof document.createElement !== 'function') return;
      let notice = document.getElementById('app-confirm-unavailable');
      if (!notice) {
        notice = document.createElement('p');
        notice.id = 'app-confirm-unavailable';
        notice.className = 'app-confirm-dialog__fallback';
        notice.setAttribute('role', 'alert');
        notice.setAttribute('tabindex', '-1');
        document.body.append(notice);
      }
      notice.textContent = message;
      notice.focus?.();
    }

    function confirm(message, {
      title = 'Confirm this action',
      confirmLabel = 'Continue',
      cancelLabel = 'Cancel'
    } = {}) {
      const safeMessage = String(message || 'Continue with this action?');
      if (activeDialog) return Promise.resolve(false);

      const dialog = document.createElement('dialog');
      if (typeof dialog.showModal !== 'function' || !document.body) {
        announceUnavailable();
        return Promise.resolve(false);
      }

      dialog.className = 'app-confirm-dialog';
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-labelledby', 'app-confirm-title');
      dialog.setAttribute('aria-describedby', 'app-confirm-message');

      const content = document.createElement('div');
      content.className = 'app-confirm-dialog__content';
      const heading = document.createElement('h2');
      heading.id = 'app-confirm-title';
      heading.textContent = String(title);
      const description = document.createElement('p');
      description.id = 'app-confirm-message';
      description.textContent = safeMessage;
      const actions = document.createElement('div');
      actions.className = 'app-confirm-dialog__actions';
      const cancelButton = document.createElement('button');
      cancelButton.className = 'button button--secondary';
      cancelButton.type = 'button';
      cancelButton.textContent = String(cancelLabel);
      cancelButton.autofocus = true;
      const confirmButton = document.createElement('button');
      confirmButton.className = 'button button--primary';
      confirmButton.type = 'button';
      confirmButton.textContent = String(confirmLabel);

      actions.append(cancelButton, confirmButton);
      content.append(heading, description, actions);
      dialog.append(content);

      const restoreFocus = document.activeElement;
      let resolveConfirmation;
      const promise = new Promise((resolve) => { resolveConfirmation = resolve; });
      activeDialog = { dialog, promise };
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        const accepted = dialog.returnValue === 'confirm';
        dialog.removeEventListener('close', finish);
        dialog.removeEventListener('click', closeFromBackdrop);
        dialog.removeEventListener('keydown', trapTab);
        dialog.remove();
        activeDialog = null;
        if (restoreFocus?.isConnected !== false) restoreFocus?.focus?.();
        resolveConfirmation(accepted);
      };
      const closeFromBackdrop = (event) => {
        if (event.target === dialog) dialog.close('cancel');
      };
      const trapTab = (event) => {
        if (event.key !== 'Tab') return;
        const focusable = [cancelButton, confirmButton].filter((button) => !button.disabled && button.isConnected !== false);
        if (!focusable.length) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        } else if (!focusable.includes(active)) {
          event.preventDefault();
          first.focus();
        }
      };

      cancelButton.addEventListener('click', () => dialog.close('cancel'));
      confirmButton.addEventListener('click', () => dialog.close('confirm'));
      dialog.addEventListener('click', closeFromBackdrop);
      dialog.addEventListener('keydown', trapTab);
      dialog.addEventListener('close', finish);
      document.body.append(dialog);
      try {
        dialog.showModal();
        cancelButton.focus();
      } catch {
        dialog.removeEventListener('close', finish);
        dialog.removeEventListener('click', closeFromBackdrop);
        dialog.removeEventListener('keydown', trapTab);
        dialog.remove();
        activeDialog = null;
        announceUnavailable();
        resolveConfirmation(false);
      }
      return promise;
    }

    window.appConfirm = confirm;
    return {
      confirm,
      destroy() {
        activeDialog?.dialog.close('cancel');
        if (window.appConfirm === confirm) delete window.appConfirm;
      }
    };
  }

  return initialize;
});
