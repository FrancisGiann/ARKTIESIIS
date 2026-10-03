(() => {
  const review = document.querySelector('[data-fee-confirmation], [data-fee-review]');
  const optionalForm = document.querySelector('.fee-optional-choice');
  if (!review || !optionalForm || review.dataset.trackOptional !== 'true') return;

  const submitButton = review.querySelector('[data-fee-submit]');
  const refreshMessage = optionalForm.querySelector('[data-fee-refresh-message]');
  if (!submitButton || !refreshMessage) return;
  const expected = review.dataset.selectedLines.split(',').filter(Boolean).sort();
  const currentSelection = () => [...optionalForm.querySelectorAll('input[name="optionalLineIds"]:checked')]
    .map((control) => control.value).sort();
  const updateConfirmationState = () => {
    const current = currentSelection();
    const stale = current.length !== expected.length || current.some((value, index) => value !== expected[index]);
    submitButton.disabled = stale;
    refreshMessage.hidden = !stale;
  };

  optionalForm.addEventListener('change', updateConfirmationState);
  updateConfirmationState();
})();
