// UI deterrent only: this does not make a password inaccessible to the device owner.
// Delegation also covers forms mounted after page load. Mark revealed password
// inputs with data-password-field so changing their type does not remove protection.
(() => {
  const passwordSelector = 'input[type="password"], input[data-password-field], input[data-password-toggle]';
  const preventPasswordExport = (event) => {
    if (event.target?.matches?.(passwordSelector)) event.preventDefault();
  };

  // Native events cover keyboard shortcuts, browser menus, and mobile copy/cut.
  // Leave paste, input, focus, selection, autofill, and context menus untouched.
  document.addEventListener('copy', preventPasswordExport, true);
  document.addEventListener('cut', preventPasswordExport, true);
})();
