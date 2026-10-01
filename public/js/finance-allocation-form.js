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

    form.querySelector('[data-add-allocation-row]')?.addEventListener('click', () => {
      if (rows.querySelectorAll('.allocation-row').length >= 120) return;
      rows.append(template.content.cloneNode(true));
    });

    form.querySelector('[data-suggest-oldest]')?.addEventListener('click', () => {
      const amountField = form.querySelector('[data-suggestion-amount]');
      let remaining = parseCents(amountField?.value || form.dataset.suggestionAmount || '');
      if (!remaining) return;
      rows.replaceChildren();
      const options = [...template.content.querySelectorAll('option[data-balance]')]
        .filter((option) => option.value && parseCents(option.dataset.balance) > 0)
        .sort((a, b) => Number(a.dataset.order || 0) - Number(b.dataset.order || 0));
      for (const option of options) {
        if (remaining <= 0 || rows.querySelectorAll('.allocation-row').length >= 120) break;
        const target = Math.min(remaining, parseCents(option.dataset.balance));
        if (!target) continue;
        const fragment = template.content.cloneNode(true);
        const select = fragment.querySelector('select[name="allocationTarget"]');
        const amount = fragment.querySelector('input[name="allocationAmount"]');
        select.value = option.value;
        amount.value = formatCents(target);
        rows.append(fragment);
        remaining -= target;
      }
    });
  });
})();
