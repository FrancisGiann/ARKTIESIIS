(() => {
  const form = document.querySelector('[data-finance-schedule-form]');
  if (!form) return;
  const rows = form.querySelector('[data-finance-line-rows]');
  const template = form.querySelector('[data-finance-line-template]');
  const addButton = form.querySelector('[data-add-finance-line]');
  if (!rows || !template || !addButton) return;
  const requiredTuitionCount = form.querySelectorAll('[data-required-tuition-line]').length;
  const maximumScheduleLines = 120;

  function numberRows() {
    [...rows.querySelectorAll('[data-finance-line-row]')].forEach((row, index) => {
      const fieldNames = ['termNumber', 'feeCategory', 'lineName', 'installment', 'lineAmount'];
      fieldNames.forEach((name) => {
        const field = row.querySelector(`[name="${name}"]`);
        const label = field?.closest('td')?.querySelector('label');
        if (!field || !label) return;
        const id = `finance-${name}-${index}`;
        field.id = id;
        label.htmlFor = id;
        label.textContent = `${label.dataset.label || name} for fee line ${index + 1}`;
      });
      const checkbox = row.querySelector('[name="optionalIndex"]');
      if (checkbox) {
        checkbox.value = String(requiredTuitionCount + index);
        checkbox.setAttribute('aria-label', `Optional fee line ${index + 1}`);
      }
      const remove = row.querySelector('[data-remove-finance-line]');
      if (remove) remove.setAttribute('aria-label', `Remove fee line ${index + 1}`);
    });
  }

  form.addEventListener('invalid', (event) => {
    const field = event.target;
    if (!(field instanceof HTMLElement)) return;
    let disclosure = field.closest('details');
    while (disclosure) {
      if (!disclosure.open) disclosure.open = true;
      disclosure = disclosure.parentElement?.closest('details') || null;
    }
  }, true);

  addButton.addEventListener('click', () => {
    if (requiredTuitionCount + rows.children.length >= maximumScheduleLines) return;
    rows.append(template.content.cloneNode(true));
    numberRows();
    rows.lastElementChild?.querySelector('[name="lineName"]')?.focus();
  });
  rows.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-finance-line]');
    if (!remove || rows.children.length <= 1) return;
    remove.closest('[data-finance-line-row]')?.remove();
    numberRows();
  });
  numberRows();
})();
