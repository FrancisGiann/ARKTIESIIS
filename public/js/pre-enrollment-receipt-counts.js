(() => {
  const form = document.querySelector('[data-pre-enrollment-form]');
  if (!form) return;

  for (const checkbox of form.querySelectorAll('[data-receipt-check]')) {
    const count = checkbox.closest('.pre-enrollment-receipt-group')?.querySelector('[data-receipt-count]');
    if (!count) continue;
    count.addEventListener('input', () => { count.dataset.receiptCountTouched = 'true'; });
    checkbox.addEventListener('change', () => {
      if (!checkbox.checked) {
        count.dataset.retainedCount = count.value;
        count.value = '';
        return;
      }
      if (count.dataset.retainedCount !== undefined) {
        count.value = count.dataset.retainedCount;
        delete count.dataset.retainedCount;
      } else if (!count.value && count.dataset.receiptCountTouched !== 'true'
        && /^[1-9]\d*$/.test(count.dataset.defaultCount || '')) {
        count.value = count.dataset.defaultCount;
      }
    });
  }
})();
