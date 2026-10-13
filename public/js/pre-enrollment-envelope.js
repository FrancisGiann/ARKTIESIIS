(() => {
  const form = document.querySelector('[data-pre-enrollment-form]');
  const checkbox = form?.querySelector('[data-envelope-receipt-checkbox]');
  const mode = form?.querySelector('[data-envelope-receipt-mode]');
  if (!checkbox || !mode) return;
  checkbox.addEventListener('change', () => { mode.value = 'replace'; });
})();
