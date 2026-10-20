'use strict';

const masterlistFilterForm = document.querySelector('.finance-masterlist-filter-form');

if (masterlistFilterForm) {
  const schoolYear = masterlistFilterForm.querySelector('#finance-masterlist-year');
  const grade = masterlistFilterForm.querySelector('#finance-masterlist-grade');
  const placementTerm = masterlistFilterForm.querySelector('#finance-masterlist-term');
  const section = masterlistFilterForm.querySelector('#finance-masterlist-section');
  const gradeHelp = masterlistFilterForm.querySelector('#finance-masterlist-grade-help');
  const sectionLabel = masterlistFilterForm.querySelector('#finance-masterlist-section-label');
  const sectionHelp = masterlistFilterForm.querySelector('#finance-masterlist-section-help');

  const disableSectionUntilReload = () => {
    if (!section) return;
    section.value = '';
    section.disabled = true;
    if (placementTerm && sectionLabel) sectionLabel.textContent = `Section in Term ${placementTerm.value}`;
    if (sectionHelp) {
      sectionHelp.textContent = `Apply filters to load sections for Term ${placementTerm?.value || ''}.`;
      sectionHelp.hidden = false;
      section.setAttribute('aria-describedby', sectionHelp.id);
    }
  };

  schoolYear?.addEventListener('change', () => {
    if (grade) {
      grade.value = '';
      grade.disabled = true;
      if (gradeHelp) {
        gradeHelp.textContent = `Apply filters to load grades for school year ${schoolYear.value}.`;
        gradeHelp.hidden = false;
        grade.setAttribute('aria-describedby', gradeHelp.id);
      }
    }
    disableSectionUntilReload();
  });

  placementTerm?.addEventListener('change', disableSectionUntilReload);
}

if (typeof document.querySelectorAll === 'function') {
  const accountToggles = [...document.querySelectorAll('[data-finance-account-toggle]')];
  const setAccountPanel = (detailsId, panelId, open) => {
    const detailsRow = document.getElementById(detailsId);
    const selectedPanel = panelId ? document.getElementById(panelId) : null;
    if (!detailsRow || (open && !selectedPanel)) return;
    const activePanel = detailsRow.querySelector('[data-finance-account-panel]:not([hidden])');
    const closing = open && activePanel === selectedPanel;
    detailsRow.hidden = !open || closing;
    for (const panel of detailsRow.querySelectorAll('[data-finance-account-panel]')) {
      panel.hidden = !open || closing || panel !== selectedPanel;
    }
    for (const toggle of accountToggles) {
      if (toggle.dataset.financeAccountRow === detailsId) {
        toggle.setAttribute('aria-expanded', String(open && !closing && toggle.getAttribute('aria-controls') === panelId));
      }
    }
  };
  for (const toggle of accountToggles) {
    toggle.addEventListener('click', () => {
      const detailsId = toggle.dataset.financeAccountRow;
      const panelId = toggle.getAttribute('aria-controls');
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      setAccountPanel(detailsId, panelId, !isOpen);
    });
  }
}
