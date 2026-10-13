'use strict';

(() => {
  function initialize(form) {
    const schoolYear = form.querySelector('[name="schoolYear"]');
    const term = form.querySelector('[name="termId"]');
    const section = form.querySelector('[name="sectionId"]');
    if (!schoolYear || !term) return;

    schoolYear.addEventListener('change', () => {
      term.value = '';
      term.disabled = true;
      if (section) section.value = '';
    });
    term.addEventListener('change', () => {
      if (section) section.value = '';
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { initialize };
  if (typeof document !== 'undefined') {
    for (const form of document.querySelectorAll('[data-finance-overview-filters]')) initialize(form);
  }
})();
