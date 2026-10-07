'use strict';

(() => {
  function initialize(form) {
    const checkbox = form.querySelector('[data-copy-student-address-checkbox]');
    const manualFields = form.querySelector('[data-emergency-address-manual-fields]');
    const preview = form.querySelector('[data-student-address-copy-preview]');
    const previewValue = form.querySelector('[data-student-address-copy-value]');
    const studentMode = form.querySelector('[data-student-address-mode]');
    const studentComponents = [...form.querySelectorAll('[data-student-address-component]')];
    const emergencyComponents = [...form.querySelectorAll('[data-emergency-address-component]')];
    const savedStudentAddress = form.dataset.savedStudentAddress || '';

    if (!checkbox || !manualFields || !preview || !previewValue) return;

    function studentAddress() {
      if (studentMode?.value !== 'replace') return savedStudentAddress;
      return studentComponents.map((field) => field.value.trim()).filter(Boolean).join(', ');
    }

    function update() {
      const checked = checkbox.checked;
      manualFields.hidden = checked;
      preview.hidden = !checked;
      for (const field of emergencyComponents) field.readOnly = checked;
      previewValue.textContent = studentAddress() || 'No student address is recorded.';
    }

    checkbox.addEventListener('change', update);
    studentMode?.addEventListener('change', update);
    for (const field of studentComponents) {
      field.addEventListener('input', update);
      field.addEventListener('change', update);
    }
    update();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { initialize };
  if (typeof document !== 'undefined') {
    for (const form of document.querySelectorAll('[data-pre-enrollment-address-copy]')) initialize(form);
  }
})();
