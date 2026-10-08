(() => {
  document.querySelectorAll('[data-payment-wizard]').forEach((form) => {
    const panels = [...form.querySelectorAll('[data-payment-step]')];
    const labels = [...form.querySelectorAll('[data-payment-step-label]')];
    if (panels.length !== 2) return;
    form.classList.add('finance-payment-wizard--enhanced');
    let active = 'details';

    function show(step, focusHeading = false) {
      active = step;
      panels.forEach((panel) => { panel.hidden = panel.dataset.paymentStep !== step; });
      labels.forEach((label) => {
        if (label.dataset.paymentStepLabel === step) label.setAttribute('aria-current', 'step');
        else label.removeAttribute('aria-current');
      });
      if (focusHeading) panels.find((panel) => panel.dataset.paymentStep === step)?.querySelector('h3')?.focus();
    }

    form.addEventListener('click', (event) => {
      const next = event.target.closest('[data-payment-next]');
      if (next) {
        const requiredFields = [...panels.find((panel) => panel.dataset.paymentStep === active).querySelectorAll('input, select, textarea')];
        const firstInvalid = requiredFields.find((field) => field.willValidate && !field.validity.valid);
        if (firstInvalid) { firstInvalid.focus(); firstInvalid.reportValidity(); return; }
        show(next.dataset.paymentNext, true);
        return;
      }
      const back = event.target.closest('[data-payment-back]');
      if (back) show(back.dataset.paymentBack, true);
    });

    show('details');
  });
})();
