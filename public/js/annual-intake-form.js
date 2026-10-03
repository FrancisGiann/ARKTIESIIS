(() => {
  const form = document.querySelector('[data-intake-wizard]');
  if (!form) return;
  const panels = [...form.querySelectorAll('[data-step-panel]')];
  const indicators = [...document.querySelectorAll('[data-step-indicator]')];
  const mode = document.getElementById('annual-student-mode');
  const returning = document.getElementById('returning-student-field');
  const newFields = document.getElementById('new-student-fields');
  const returningInput = document.getElementById('annual-student-no');
  const year = document.getElementById('annual-school-year');
  const grade = document.getElementById('annual-grade');
  const entryTerm = document.getElementById('annual-entry-term');
  const sectionMode = document.getElementById('annual-section-mode');
  const commonSectionField = document.getElementById('annual-common-section-field');
  const commonSection = document.getElementById('annual-common-section');
  const preview = document.getElementById('annual-section-plan-preview');
  const termSelects = [...form.querySelectorAll('[data-term-select]')];
  const overrideInputFor = (termNumber) => document.getElementById(`annual-section-${termNumber}-override`);
  let activeStep = Math.max(1, Math.min(3, Number(form.dataset.activeStep || 1)));

  const updateMode = () => {
    const isReturning = mode.value === 'returning';
    returning.hidden = !isReturning;
    newFields.hidden = isReturning;
    returningInput.required = isReturning;
    returningInput.disabled = !isReturning;
    newFields.querySelectorAll('input, textarea').forEach((input) => {
      input.disabled = isReturning;
      input.required = !isReturning && ['annual-lrn', 'annual-email', 'annual-first-name', 'annual-last-name'].includes(input.id);
    });
  };

  const matchingSections = (select, termNumber) => [...select.options].slice(1).filter((option) =>
    (!year.value || option.dataset.year === year.value)
    && (!grade.value || option.dataset.grade === grade.value)
    && Number(option.dataset.termNumber) === termNumber);

  const updateSections = () => {
    if (!year || !grade || !entryTerm || !sectionMode || !commonSection || !preview) return;
    const entryNumber = Number(entryTerm.value || 1);
    const sameAcrossTerms = sectionMode.value === 'same';
    for (const [index, select] of termSelects.entries()) {
      const termNumber = Number(select.dataset.termNumber || index + 1);
      const wrapper = select.closest('[data-placement-number]');
      for (const option of [...select.options].slice(1)) {
        const isVisible = (!year.value || option.dataset.year === year.value)
          && (!grade.value || option.dataset.grade === grade.value)
          && Number(option.dataset.termNumber) === termNumber;
        option.hidden = !isVisible;
        if (option.selected && !isVisible) select.value = '';
      }
      if (termNumber < entryNumber) {
        wrapper.hidden = true;
        select.disabled = true;
        select.required = false;
        select.value = '';
      } else {
        select.disabled = false;
        select.required = !sameAcrossTerms && termNumber === entryNumber;
      }
    }
    for (const option of [...commonSection.options].slice(1)) {
      const isVisible = (!year.value || option.dataset.year === year.value)
        && (!grade.value || option.dataset.grade === grade.value)
        && Number(option.dataset.termNumber) === entryNumber;
      option.hidden = !isVisible;
      if (option.selected && !isVisible) commonSection.value = '';
    }
    commonSectionField.hidden = !sameAcrossTerms;
    commonSection.disabled = !sameAcrossTerms;
    commonSection.required = sameAcrossTerms;
    const selectedCommon = commonSection.selectedOptions[0];
    const canonical = selectedCommon && selectedCommon.value ? selectedCommon.dataset : null;
    const messages = [];
    for (const select of termSelects) {
      const termNumber = Number(select.dataset.termNumber);
      const wrapper = select.closest('[data-placement-number]');
      if (termNumber < entryNumber) continue;
      if (!sameAcrossTerms) {
        wrapper.hidden = false;
        const selected = select.selectedOptions[0];
        messages.push(`Term ${termNumber}: ${selected?.value ? selected.textContent.trim() : termNumber === entryNumber ? 'choose the entry section' : 'can stay unassigned'}.`);
        continue;
      }
      if (!canonical) {
        select.value = '';
        wrapper.hidden = termNumber !== entryNumber;
        messages.push(`Term ${termNumber}: ${termNumber === entryNumber ? 'choose the entry section above' : 'will stay unassigned until a matching section is available'}.`);
        continue;
      }
      if (termNumber === entryNumber) {
        select.value = commonSection.value;
        wrapper.hidden = true;
        messages.push(`Term ${termNumber}: ${selectedCommon.textContent.trim()}.`);
        continue;
      }
      const matches = matchingSections(select, termNumber).filter((option) =>
        String(option.dataset.name || '').trim().toLocaleLowerCase() === String(canonical.name || '').trim().toLocaleLowerCase()
        && String(option.dataset.cluster || '').trim().toLocaleLowerCase() === String(canonical.cluster || '').trim().toLocaleLowerCase()
        && String(option.dataset.strand || '').trim().toLocaleLowerCase() === String(canonical.strand || '').trim().toLocaleLowerCase());
      const override = overrideInputFor(termNumber);
      const isExplicit = select.dataset.explicit === 'true' || override.value === '1';
      if (!isExplicit && matches.length === 1) select.value = matches[0].value;
      if (!isExplicit && matches.length !== 1) select.value = '';
      const selected = select.selectedOptions[0];
      wrapper.hidden = !isExplicit && matches.length === 1;
      if (isExplicit && selected?.value) messages.push(`Term ${termNumber}: chosen separately — ${selected.textContent.trim()}.`);
      else if (isExplicit) messages.push(`Term ${termNumber}: left unassigned by choice.`);
      else if (matches.length === 1) messages.push(`Term ${termNumber}: matched — ${matches[0].textContent.trim()}.`);
      else if (matches.length > 1) {
        wrapper.hidden = false;
        messages.push(`Term ${termNumber}: more than one match; choose a section or leave it open.`);
      } else {
        wrapper.hidden = false;
        messages.push(`Term ${termNumber}: no match; choose a section or leave this future term open.`);
      }
    }
    preview.replaceChildren(...messages.map((message) => {
      const item = document.createElement('li');
      item.textContent = message;
      return item;
    }));
  };

  const updatePaperRows = () => {
    document.querySelectorAll('[data-requirement-applicability]').forEach((row) => {
      const applicability = row.dataset.requirementApplicability;
      const gradeOnly = applicability === 'grade11' ? 'Grade 11' : applicability === 'grade12' ? 'Grade 12' : null;
      row.hidden = Boolean(gradeOnly && grade.value && grade.value !== gradeOnly);
      const record = row.querySelector('[data-paper-record]');
      const details = row.querySelector('[data-paper-details]');
      const active = record.checked && !row.hidden;
      record.disabled = row.hidden;
      if (details) details.open = active;
      row.querySelectorAll('[data-paper-update-fields] select').forEach((control) => {
        control.disabled = !active;
        control.required = active;
      });
      row.querySelectorAll('.paper-checklist-row__details input').forEach((control) => {
        control.disabled = !active;
        control.required = false;
      });
    });
  };

  const showStep = (number, focus = false) => {
    activeStep = Math.max(1, Math.min(3, number));
    panels.forEach((panel) => { panel.hidden = Number(panel.dataset.stepPanel) !== activeStep; });
    indicators.forEach((indicator) => {
      const current = Number(indicator.dataset.stepIndicator) === activeStep;
      indicator.setAttribute('aria-current', current ? 'step' : 'false');
    });
    form.dataset.activeStep = String(activeStep);
    if (focus) panels.find((panel) => Number(panel.dataset.stepPanel) === activeStep)?.querySelector('h2')?.focus();
  };

  form.querySelectorAll('[data-step-next]').forEach((button) => button.addEventListener('click', () => {
    const panel = button.closest('[data-step-panel]');
    const invalid = [...panel.querySelectorAll('input, select, textarea')].find((control) => !control.disabled && !control.checkValidity());
    if (invalid) { invalid.reportValidity(); return; }
    showStep(Number(panel.dataset.stepPanel) + 1, true);
  }));
  form.querySelectorAll('[data-step-back]').forEach((button) => button.addEventListener('click', () => {
    showStep(Number(button.closest('[data-step-panel]').dataset.stepPanel) - 1, true);
  }));

  mode.addEventListener('change', updateMode);
  year.addEventListener('change', () => { commonSection.value = ''; updateSections(); });
  grade.addEventListener('change', () => { commonSection.value = ''; updateSections(); updatePaperRows(); });
  entryTerm.addEventListener('change', () => { commonSection.value = ''; updateSections(); });
  sectionMode.addEventListener('change', updateSections);
  commonSection.addEventListener('change', () => {
    termSelects.forEach((select) => {
      if (Number(select.dataset.termNumber) > Number(entryTerm.value || 1)) {
        select.value = '';
        select.dataset.explicit = 'false';
        overrideInputFor(select.dataset.termNumber).value = '';
      }
    });
    updateSections();
  });
  termSelects.forEach((select) => select.addEventListener('change', () => {
    if (sectionMode.value === 'same' && Number(select.dataset.termNumber) > Number(entryTerm.value || 1)) {
      select.dataset.explicit = 'true';
      overrideInputFor(select.dataset.termNumber).value = select.value ? '' : '1';
    }
    updateSections();
  }));
  form.querySelectorAll('[data-paper-record]').forEach((checkbox) => checkbox.addEventListener('change', updatePaperRows));
  form.querySelectorAll('[data-paper-update-fields] select[name$="_status"]').forEach((select) => select.addEventListener('change', updatePaperRows));
  termSelects.forEach((select) => {
    if (select.value) select.dataset.explicit = 'true';
  });
  updateMode();
  updateSections();
  updatePaperRows();
  showStep(activeStep);
  const error = document.querySelector('[data-wizard-error]');
  if (error) error.focus();
})();
