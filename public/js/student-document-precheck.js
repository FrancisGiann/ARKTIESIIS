(() => {
  for (const form of document.querySelectorAll('form[data-student-precheck]')) {
    const file = form.querySelector('input[type="file"][name="document"]');
    const type = form.querySelector('[name="documentType"]');
    const token = form.querySelector('[name="precheckToken"]');
    const checkButton = form.querySelector('[data-check-document]');
    const proceed = form.querySelector('[data-proceed-document]');
    const result = form.querySelector('[data-precheck-result]');
    if (!file || !type || !token || !checkButton || !proceed || !result) continue;
    checkButton.hidden = false;
    const replaceButton = form.querySelector('[data-replace-document]');
    if (replaceButton) replaceButton.hidden = false;
    let generation = 0;
    let busy = false;
    const normalSubmitLabel = 'Submit for manual review';

    function message(text, warnings = []) {
      result.replaceChildren();
      if (warnings.length) {
        const heading = document.createElement('strong');
        heading.textContent = 'Possible issue with this document';
        result.append(heading);
      }
      const summary = document.createElement('p');
      summary.textContent = text;
      result.append(summary);
      if (warnings.length) {
        const list = document.createElement('ul');
        for (const warning of warnings) {
          const item = document.createElement('li');
          item.textContent = warning;
          list.append(item);
        }
        result.append(list);
        const choice = document.createElement('p');
        choice.textContent = 'You can choose another file or submit this one anyway. Staff will review it; this warning does not reject your submission.';
        result.append(choice);
      }
    }

    function invalidate() {
      generation += 1;
      token.value = '';
      proceed.disabled = false;
      proceed.textContent = normalSubmitLabel;
      message(file.files?.length
        ? 'You can check this file for possible issues, or submit it directly for manual staff review.'
        : 'Choose a file to begin. The AI check is optional.');
    }
    file.addEventListener('change', invalidate);
    type.addEventListener('change', invalidate);
    replaceButton?.addEventListener('click', () => file.click());
    invalidate();

    checkButton.addEventListener('click', async () => {
      if (busy) return;
      if (!file.files?.length || !type.value) {
        message('Choose a document type and file first.');
        (!type.value ? type : file).focus();
        return;
      }
      const selected = file.files[0];
      const version = generation;
      const formData = new FormData();
      formData.append('_csrf', form.querySelector('[name="_csrf"]')?.value || '');
      formData.append('documentType', type.value);
      if (form.dataset.assignmentId) formData.append('requirementAssignmentId', form.dataset.assignmentId);
      if (form.dataset.documentId) formData.append('documentId', form.dataset.documentId);
      formData.append('document', selected);
      busy = true;
      checkButton.disabled = true;
      message('Checking the selected file. This may take a moment.');
      try {
        const response = await fetch('/documents/precheck', {
          method: 'POST', body: formData, credentials: 'same-origin',
          headers: { Accept: 'application/json' }, cache: 'no-store'
        });
        const data = await response.json().catch(() => ({}));
        if (version !== generation || file.files?.[0] !== selected) return;
        if (!response.ok) {
          message(data.error || (response.status === 413
            ? 'The selected file exceeds the upload limit. Choose a smaller file.'
            : response.status === 400
              ? 'The file format could not be accepted. Choose a PDF, JPEG, or PNG.'
              : 'The early check is unavailable. You may still submit for staff review.'));
          if (response.status === 400 || response.status === 413) proceed.disabled = true;
          if (response.status >= 500 || response.status === 429) {
            proceed.textContent = 'Submit for manual review';
          }
          return;
        }
        token.value = data.token || '';
        const warnings = Array.isArray(data.warnings) ? data.warnings : [];
        message(data.message || 'Staff review is still required.', warnings);
        proceed.textContent = warnings.length ? 'Submit anyway'
          : data.status === 'limited' || data.status === 'unavailable' ? 'Submit for manual review'
            : normalSubmitLabel;
        proceed.disabled = false;
      } catch {
        if (version === generation) {
          message('The early check is unavailable. You may still submit for staff review.');
          proceed.disabled = false;
          proceed.textContent = 'Submit for manual review';
        }
      } finally {
        busy = false;
        checkButton.disabled = false;
      }
    });
  }
})();
