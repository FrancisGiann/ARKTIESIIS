(() => {
  const form = document.querySelector('[data-pre-enrollment-form]');
  if (!form) return;

  const selectAll = form.querySelector('[data-select-all-receipts]');
  const pairs = [];
  for (const checkbox of form.querySelectorAll('[data-receipt-check]')) {
    const count = checkbox.closest('.pre-enrollment-receipt-group')?.querySelector('[data-receipt-count]');
    if (!count) continue;
    pairs.push({ checkbox, count });
    count.addEventListener('input', () => { count.dataset.receiptCountTouched = 'true'; });
  }

  const eligible = () => pairs.filter(({ checkbox, count }) => !checkbox.disabled
    && /^[1-9]\d*$/.test(count.dataset.defaultCount || ''));
  const syncSelectAll = () => {
    if (!selectAll) return;
    const items = eligible();
    const checked = items.filter(({ checkbox }) => checkbox.checked).length;
    selectAll.disabled = items.length === 0;
    selectAll.checked = items.length > 0 && checked === items.length;
    selectAll.indeterminate = checked > 0 && checked < items.length;
  };
  const updateReceipt = (checkbox, count) => {
      if (!checkbox.checked) {
        count.dataset.retainedCount = count.value;
        count.value = '';
      } else if (count.dataset.retainedCount !== undefined) {
        count.value = count.dataset.retainedCount;
        delete count.dataset.retainedCount;
      } else if (!count.value && count.dataset.receiptCountTouched !== 'true'
        && /^[1-9]\d*$/.test(count.dataset.defaultCount || '')) {
        count.value = count.dataset.defaultCount;
      }
  };
  for (const { checkbox, count } of pairs) {
    checkbox.addEventListener('change', () => { updateReceipt(checkbox, count); syncSelectAll(); });
  }
  selectAll?.addEventListener('change', () => {
    const selected = selectAll.checked;
    for (const { checkbox, count } of eligible()) {
      if (checkbox.checked === selected) continue;
      checkbox.checked = selected;
      updateReceipt(checkbox, count);
    }
    syncSelectAll();
  });
  syncSelectAll();
})();
