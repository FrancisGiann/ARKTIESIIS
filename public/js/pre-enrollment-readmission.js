'use strict';

(() => {
  function initialize(form) {
    const applicantKind = form.querySelector('#pre-applicant-kind');
    const evaluation = form.querySelector('#pre-readmission-evaluation');
    const field = form.querySelector('[data-readmission-evaluation-field]');
    if (!applicantKind || !evaluation || !field) return;

    function update() {
      const required = applicantKind.value === 'readmission';
      field.hidden = !required;
      evaluation.disabled = !required;
      evaluation.required = required;
    }

    applicantKind.addEventListener('change', update);
    update();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { initialize };
  if (typeof document !== 'undefined') {
    for (const form of document.querySelectorAll('[data-pre-enrollment-form]')) initialize(form);
  }
})();
