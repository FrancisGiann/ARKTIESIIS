'use strict';

(() => {
  const rows = document.querySelectorAll('[data-departure-charge-review]');
  if (!rows.length) return;

  function isBlankOrZeroAmount(value) {
    const raw = String(value || '').trim();
    if (!raw) return true;
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw)) return false;
    const [whole, fraction = ''] = raw.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) === 0n;
  }

  for (const row of rows) {
    const amount = row.querySelector('[name$="_reductionAmount"]');
    const amountField = row.querySelector('[data-departure-reduction-field]');
    const error = row.querySelector('[data-keep-amount-error]');
    const choices = [...row.querySelectorAll('input[type="radio"][name$="_decision"]')];
    if (!amount || !amountField || !choices.length) continue;
    let recoveredKeepNeedsCorrection = row.dataset?.keepAmountNeedsCorrection === 'true';

    const updateAmountVisibility = () => {
      const decision = choices.find((choice) => choice.checked)?.value || '';
      const validKeepAmount = isBlankOrZeroAmount(amount.value);
      const showAmount = decision === 'reduce'
        || (decision === 'retain' && recoveredKeepNeedsCorrection && !validKeepAmount)
        || (!decision && amount.value.trim() !== '');

      amountField.hidden = !showAmount;
      amount.disabled = !showAmount;
      amount.setAttribute('aria-required', decision === 'reduce' ? 'true' : 'false');
      if (error) error.hidden = decision !== 'retain' || !recoveredKeepNeedsCorrection || validKeepAmount;
    };

    for (const choice of choices) {
      choice.addEventListener('change', () => {
        recoveredKeepNeedsCorrection = false;
        updateAmountVisibility();
      });
    }
    amount.addEventListener('input', () => {
      if (choices.find((choice) => choice.checked)?.value === 'retain' && isBlankOrZeroAmount(amount.value)) {
        recoveredKeepNeedsCorrection = false;
      }
      updateAmountVisibility();
    });
    updateAmountVisibility();
  }

  const cutoff = document.querySelector('[name="field_cutoffInstallment"]');
  cutoff?.addEventListener('change', () => {
    for (const row of rows) {
      if (row.dataset?.canonicalTuition !== 'true') continue;
      const choices = row.querySelectorAll('input[type="radio"][name$="_decision"]');
      for (const choice of choices) choice.checked = false;
      const amount = row.querySelector('[name$="_reductionAmount"]');
      if (amount) amount.value = '';
      choices[0]?.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // The refreshed preview recalculates suggestions for the newly selected cutoff.
  });
})();
