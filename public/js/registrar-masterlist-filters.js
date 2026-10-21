'use strict';

(() => {
  const term = document.getElementById('masterlist-term');
  const section = document.getElementById('masterlist-section');
  const schoolYear = document.getElementById('masterlist-school-year');
  const grade = document.getElementById('masterlist-grade');
  if (!term || !section || !schoolYear || !grade) return;
  const filterSections = () => {
    for (const option of section.options) {
      if (!option.value) continue;
        const visible = (!term.value || option.dataset.term === term.value)
          && (!schoolYear.value || option.dataset.year === schoolYear.value)
          && (!grade.value || option.dataset.grade === grade.value);
      option.hidden = !visible;
      option.disabled = !visible;
      if (!visible && option.selected) section.value = '';
    }
  };
  term.addEventListener('change', filterSections);
  schoolYear.addEventListener('change', filterSections);
  grade.addEventListener('change', filterSections);
  filterSections();
})();
