(() => {
  const parseCents = (value) => {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value || '').trim());
    if (!match) return 0;
    return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  };
  const formatCents = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

  document.querySelectorAll('[data-allocation-form]').forEach((form) => {
    const rows = form.querySelector('[data-allocation-rows]');
    const template = form.querySelector('template[data-allocation-row-template]');
    if (!rows || !template) return;
    const extraDetails = form.querySelector('[data-allocation-extra-details]');
    const extraRows = extraDetails?.querySelector('[data-allocation-extra-rows]');
    const primaryRow = extraDetails ? rows.querySelector('.allocation-row') : null;

    function appendExtraRow(fragment) {
      if (extraDetails && extraRows) {
        extraDetails.open = true;
        extraRows.append(fragment);
      } else rows.append(fragment);
    }

    function clearRowsForSuggestion() {
      if (!extraDetails || !primaryRow || !extraRows) {
        rows.replaceChildren();
        return;
      }
      primaryRow.querySelector('select[name="allocationTarget"]').value = '';
      primaryRow.querySelector('input[name="allocationAmount"]').value = '';
      extraRows.replaceChildren();
      extraDetails.open = true;
    }

    function addSuggestedRow(targetValue, amountValue) {
      if (primaryRow && extraRows) {
        const primarySelect = primaryRow.querySelector('select[name="allocationTarget"]');
        const primaryAmount = primaryRow.querySelector('input[name="allocationAmount"]');
        if (!primarySelect.value && !primaryAmount.value) {
          primarySelect.value = targetValue;
          primaryAmount.value = amountValue;
          return;
        }
      }
      const fragment = template.content.cloneNode(true);
      fragment.querySelector('select[name="allocationTarget"]').value = targetValue;
      fragment.querySelector('input[name="allocationAmount"]').value = amountValue;
      appendExtraRow(fragment);
    }

    form.querySelector('[data-add-allocation-row]')?.addEventListener('click', () => {
      if (rows.querySelectorAll('.allocation-row').length >= 120) return;
      appendExtraRow(template.content.cloneNode(true));
    });

    form.querySelector('[data-suggest-oldest]')?.addEventListener('click', () => {
      const amountField = form.querySelector('[data-suggestion-amount]');
      let remaining = parseCents(amountField?.value || form.dataset.suggestionAmount || '');
      if (!remaining) return;
      clearRowsForSuggestion();
      const options = [...template.content.querySelectorAll('option[data-balance]')]
        .filter((option) => option.value && parseCents(option.dataset.balance) > 0)
        .sort((a, b) => Number(a.dataset.order || 0) - Number(b.dataset.order || 0));
      for (const option of options) {
        if (remaining <= 0 || rows.querySelectorAll('.allocation-row').length >= 120) break;
        const target = Math.min(remaining, parseCents(option.dataset.balance));
        if (!target) continue;
        addSuggestedRow(option.value, formatCents(target));
        remaining -= target;
      }
    });
  });
})();
