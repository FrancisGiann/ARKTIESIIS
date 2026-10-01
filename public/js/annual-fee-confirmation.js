(() => {
  const review = document.querySelector('[data-fee-confirmation]');
  const optionalForm = document.querySelector('.fee-optional-choice');
  if (!review || !optionalForm) return;

  const confirmButton = review.querySelector('[data-fee-confirm]');
  const refreshMessage = optionalForm.querySelector('[data-fee-refresh-message]');
  const expected = review.dataset.selectedLines.split(',').filter(Boolean).sort();
  const currentSelection = () => [...optionalForm.querySelectorAll('input[name="optionalLineIds"]:checked')]
    .map((control) => control.value).sort();
  const updateConfirmationState = () => {
    const current = currentSelection();
    const stale = current.length !== expected.length || current.some((value, index) => value !== expected[index]);
    confirmButton.disabled = stale;
    refreshMessage.hidden = !stale;
  };

  optionalForm.addEventListener('change', updateConfirmationState);
  updateConfirmationState();
})();
