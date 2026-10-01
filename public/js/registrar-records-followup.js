(() => {
  for (const form of document.querySelectorAll('.document-request-status-form')) {
    const status = form.querySelector('[name="status"]');
    if (!status) continue;
    const syncFields = () => {
      for (const field of form.querySelectorAll('.request-status-conditional')) {
        const visible = field.dataset.statusOnly === status.value;
        field.hidden = !visible;
        for (const input of field.querySelectorAll('input, select, textarea')) {
          if (!visible) input.value = '';
          input.disabled = !visible;
          input.required = input.dataset.requiredStatus === status.value;
        }
      }
    };
    status.addEventListener('change', syncFields);
    syncFields();
  }

  const term = document.querySelector('#grade-term');
  const section = document.querySelector('#grade-section');
  if (term && section) {
    const syncSections = (clearMismatchedSelection) => {
      for (const option of section.options) {
        if (!option.value) continue;
        const visible = !term.value || option.dataset.termId === term.value;
        option.hidden = !visible;
        if (!visible && clearMismatchedSelection && option.selected) section.value = '';
      }
    };
    term.addEventListener('change', () => syncSections(true));
    syncSections(true);
  }
})();
