(() => {
  function initialize(scope = document) {
    const forms = scope.querySelectorAll('[data-retake-item-form]');
    forms.forEach((form) => {
      const termSelect = form.querySelector('[name="targetTerm"]');
      const subjectSelect = form.querySelector('[data-retake-subject-select]');
      if (!termSelect || !subjectSelect) return;
      const subjectOptions = Array.from(subjectSelect.options).filter((option) => option.dataset.term);

      function filterSubjects(clearStaleSelection) {
        if (clearStaleSelection) {
          const selected = subjectSelect.selectedOptions[0];
          if (selected?.dataset.term && selected.dataset.term !== termSelect.value) subjectSelect.value = '';
        }
        subjectOptions.forEach((option) => {
          const available = option.dataset.term === termSelect.value;
          option.hidden = !available;
          option.disabled = !available;
        });
      }

      termSelect.addEventListener('change', () => filterSubjects(true));
      filterSubjects(false);
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { initialize };
  if (typeof document !== 'undefined') initialize(document);
})();
