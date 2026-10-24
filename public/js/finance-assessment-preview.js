(() => {
  const dialog = document.querySelector('[data-assessment-preview-dialog]');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const closeLink = dialog.querySelector('[data-assessment-preview-close]');
  const opener = [...document.querySelectorAll('[data-assessment-preview-form]')]
    .find((form) => form.dataset.annualId === dialog.dataset.annualId)?.querySelector('button[type="submit"]');

  dialog.removeAttribute('open');
  dialog.showModal();
  document.body.classList.add('finance-assessment-dialog-open');
  closeLink?.focus();
  closeLink?.addEventListener('click', (event) => {
    event.preventDefault();
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('finance-assessment-dialog-open');
    if (opener?.isConnected) opener.focus();
  });
})();
