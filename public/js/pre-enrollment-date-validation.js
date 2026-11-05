'use strict';

(() => {
  function validateDateControl(control) {
    const message = control.validity.badInput
      ? 'Enter a complete, valid date, or clear this field.'
      : '';
    control.setCustomValidity(message);
    return control.checkValidity();
  }

  function initialize(form) {
    const dateControls = [...form.querySelectorAll('input[type="date"]')];
    for (const control of dateControls) {
      const validate = () => validateDateControl(control);
      validate();
      control.addEventListener('input', validate);
      control.addEventListener('change', validate);
    }

    form.addEventListener('submit', (event) => {
      const invalidControl = dateControls.find((control) => !validateDateControl(control));
      if (!invalidControl) return;
      event.preventDefault();
      invalidControl.focus();
      invalidControl.reportValidity();
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { initialize, validateDateControl };
  if (typeof document !== 'undefined') {
    for (const form of document.querySelectorAll('[data-pre-enrollment-date-validation]')) initialize(form);
  }
})();
