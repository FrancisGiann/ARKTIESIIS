(() => {
  const phonePattern = /^[+0-9() \x2d]+$/;
  const personNameFields = new Set(['firstName', 'middleName', 'lastName', 'suffix', 'emergencyContactPerson',
    'motherName', 'fatherName']);
  const personNameMaxLength = (name) => name === 'suffix' ? 20
    : ['emergencyContactPerson', 'motherName', 'fatherName'].includes(name) ? 160 : 100;
  const personNamePattern = /^\p{L}[\p{L}\p{M}]*(?:[.\x2d'’][\p{L}\p{M}]+)*\.?(?:\s+\p{L}[\p{L}\p{M}]*(?:[.\x2d'’][\p{L}\p{M}]+)*\.?)*$/u;
  let nextFeedbackId = 0;

  const isValidPhone = (value) => {
    if (!value) return true;
    if (value.length > 50) return false;
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

  const updateFeedback = (control, message) => {
    const field = control.closest?.('.field') || control.parentElement;
    let feedback = field?.querySelector?.('[data-profile-validation-error]') || null;
    if (!feedback && message && typeof document !== 'undefined' && field) {
      feedback = document.createElement('small');
      feedback.className = 'form-field-error';
      feedback.dataset.profileValidationError = '';
      feedback.setAttribute('role', 'status');
      feedback.setAttribute('aria-live', 'polite');
      feedback.id = `${control.id || `profile-control-${++nextFeedbackId}`}-validation-error`;
      if (typeof control.insertAdjacentElement === 'function') control.insertAdjacentElement('afterend', feedback);
      else field.appendChild(feedback);
      const describedBy = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (!describedBy.includes(feedback.id)) {
        describedBy.push(feedback.id);
        control.setAttribute('aria-describedby', describedBy.join(' '));
      }
    }

    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
    if (feedback) {
      feedback.textContent = message;
      feedback.hidden = !message;
    }
  };

  const validateControl = (control) => {
    if (control.disabled || control.readOnly) return true;
    let message = '';
    const value = typeof control.value === 'string' ? control.value : '';
    const trimmedValue = value.trim();
    if (personNameFields.has(control.name) && trimmedValue.length > personNameMaxLength(control.name)) {
      message = `Use ${personNameMaxLength(control.name)} characters or fewer.`;
    } else if (personNameFields.has(control.name) && trimmedValue && !personNamePattern.test(trimmedValue)) {
      message = 'Use letters, spaces, hyphens, apostrophes, and initials only.';
    } else if ((control.name === 'lrn' || control.name === 'applicantLrn') && value) {
      const pattern = control.getAttribute?.('pattern') || control.pattern || '';
      const allowDraftPartial = pattern === '[0-9]{0,12}';
      const validLrn = allowDraftPartial ? /^\d{1,12}$/.test(value) : /^\d{12}$/.test(value);
      if (!validLrn) message = allowDraftPartial ? 'Use digits only; a Draft can contain up to 12 digits.' : 'Enter exactly 12 digits.';
    } else if (control.tagName === 'TEXTAREA' && /address$/i.test(control.name) && trimmedValue && !/\p{L}/u.test(value)) {
      message = 'Address must include at least one letter.';
    } else if (control.tagName === 'SELECT' && control.name === 'sex' && control.value
      && !['Male', 'Female', 'Other'].includes(control.value)
      && !(control.value === 'unspecified' && control.form?.hasAttribute('data-allow-legacy-unspecified'))) {
      message = 'Choose Male, Female, or Other for gender.';
    } else if (control.type === 'tel' && trimmedValue.length > 50) {
      message = 'Use 50 characters or fewer for a phone number.';
    } else if (control.type === 'tel' && !isValidPhone(trimmedValue)) {
      message = 'Use 7 to 15 digits; a leading +, spaces, hyphens, and balanced parentheses are allowed.';
    } else if (control.type === 'email' && trimmedValue
      && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedValue)) {
      message = 'Enter a complete email address, such as learner@example.edu.';
    } else if (control.type === 'date' && control.name === 'birthDate' && control.value && control.max && control.value > control.max) {
      message = 'Birth date must be before today.';
    }
    control.setCustomValidity(message);
    updateFeedback(control, message);
    return control.checkValidity();
  };

  const firstInvalidControl = (formOrPanel) => {
    const controls = [...formOrPanel.querySelectorAll('input, select, textarea')];
    const trimNames = new Set(['firstName', 'middleName', 'lastName', 'suffix', 'phone', 'emergencyContactPhone',
      'motherPhone', 'fatherPhone', 'email']);
    controls.forEach((control) => {
      if (!control.disabled && !control.readOnly && trimNames.has(control.name)) control.value = control.value.trim();
    });
    return controls.find((control) => !validateControl(control)) || null;
  };

  const focusInvalidControl = (control) => {
    control.closest('details')?.setAttribute('open', '');
    control.focus();
    control.reportValidity();
  };

  const initializeForm = (form) => {
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
  };

  if (typeof window !== 'undefined') {
    window.ARKTIESIISProfileValidation = { firstInvalidControl, focusInvalidControl, validateControl };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { firstInvalidControl, focusInvalidControl, validateControl, isValidPhone, initializeForm };
  }

  if (typeof document !== 'undefined') {
    document.querySelectorAll('form[data-profile-validation], form[data-intake-wizard]').forEach((form) => {
      initializeForm(form);
    });
  }
})();
