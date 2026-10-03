(() => {
  const phonePattern = /^[+0-9() \x2d]+$/;

  const isValidPhone = (value) => {
    if (!value) return true;
    if (!phonePattern.test(value) || value.indexOf('+', 1) !== -1) return false;
    const digits = value.replace(/\D/g, '');
    const visible = value.replace(/^\+/, '').trim();
    if (digits.length < 7 || digits.length > 15 || !/^[0-9(]/.test(visible) || !/[0-9)]$/.test(visible)) return false;
    let depth = 0;
    let hasDigit = false;
    for (const character of value) {
      if (character === '(') {
        if (depth) return false;
        depth = 1;
        hasDigit = false;
      } else if (character === ')') {
        if (!depth || !hasDigit) return false;
        depth = 0;
      } else if (depth && /[0-9]/.test(character)) {
        hasDigit = true;
      }
    }
    return depth === 0;
  };

  const validateControl = (control) => {
    if (control.disabled) return true;
    let message = '';
    if (control.tagName === 'TEXTAREA' && /address$/i.test(control.name) && control.value.trim() && !/\p{L}/u.test(control.value)) {
      message = 'Address must include at least one letter.';
    } else if (control.tagName === 'SELECT' && control.name === 'sex' && control.value
      && !['Male', 'Female', 'Other'].includes(control.value)
      && !(control.value === 'unspecified' && control.form?.hasAttribute('data-allow-legacy-unspecified'))) {
      message = 'Choose Male, Female, or Other for gender.';
    } else if (control.type === 'tel' && !isValidPhone(control.value.trim())) {
      message = 'Use 7 to 15 digits; a leading +, spaces, hyphens, and balanced parentheses are allowed.';
    } else if (control.type === 'email' && control.value.trim()
      && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(control.value.trim())) {
      message = 'Enter a complete email address, such as learner@example.edu.';
    } else if (control.type === 'date' && control.name === 'birthDate' && control.value && control.max && control.value > control.max) {
      message = 'Birth date must be before today.';
    }
    control.setCustomValidity(message);
    return control.checkValidity();
  };

  const firstInvalidControl = (formOrPanel) => {
    const controls = [...formOrPanel.querySelectorAll('input, select, textarea')];
    const trimNames = new Set(['firstName', 'middleName', 'lastName', 'suffix', 'phone', 'emergencyContactPhone',
      'motherPhone', 'fatherPhone', 'email']);
    controls.forEach((control) => {
      if (!control.disabled && trimNames.has(control.name)) control.value = control.value.trim();
    });
    return controls.find((control) => !validateControl(control)) || null;
  };

  const focusInvalidControl = (control) => {
    control.closest('details')?.setAttribute('open', '');
    control.focus();
    control.reportValidity();
  };

  window.ARKTIESIISProfileValidation = { firstInvalidControl, focusInvalidControl, validateControl };

  document.querySelectorAll('form[data-profile-validation], form[data-intake-wizard]').forEach((form) => {
    form.noValidate = true;
    const controls = [...form.querySelectorAll('input, select, textarea')];
    controls.forEach((control) => {
      validateControl(control);
      control.addEventListener('input', () => validateControl(control));
      control.addEventListener('change', () => validateControl(control));
    });
    if (!form.matches('[data-intake-wizard]')) {
      form.addEventListener('submit', (event) => {
        const invalid = firstInvalidControl(form);
        if (invalid) {
          event.preventDefault();
          focusInvalidControl(invalid);
        }
      }, true);
    }
  });
})();
