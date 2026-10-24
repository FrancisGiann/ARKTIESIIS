(() => {
  const types = new Map([['pdf', 'application/pdf'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png']]);
  const checked = new WeakMap();
  const resubmitting = new WeakSet();

  function feedback(input, message) {
    let notice = input.parentElement.querySelector('[data-file-type-error]');
    if (!notice) {
      notice = document.createElement('small');
      notice.dataset.fileTypeError = '';
      notice.className = 'form-field-error';
      notice.setAttribute('role', 'alert');
      input.insertAdjacentElement('afterend', notice);
    }
    notice.textContent = message;
  }

  async function inspect(input) {
    const file = input.files?.[0];
    if (!file) return false;
    const extension = file.name.split('.').pop()?.toLowerCase();
    const expected = types.get(extension);
    if (!expected || (file.type && file.type !== expected)) {
      if (input.files?.[0] === file) feedback(input, 'Choose a PDF, JPEG, or PNG file whose name and type match.');
      return false;
    }
    const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const valid = expected === 'application/pdf'
      ? bytes.length >= 5 && [37, 80, 68, 70, 45].every((byte, index) => bytes[index] === byte)
      : expected === 'image/jpeg'
        ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    if (input.files?.[0] !== file) return false;
    feedback(input, valid ? '' : 'The file content does not match its PDF, JPEG, or PNG type. Choose another file.');
    if (valid) checked.set(input, file);
    return valid;
  }

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !['document', 'form137Scan'].includes(input.name)) return;
    checked.delete(input);
    const chosen = input.files?.[0];
    if (chosen) inspect(input).catch(() => {
      if (input.files?.[0] === chosen) feedback(input, 'The file could not be checked. Choose another file.');
    });
  });

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (resubmitting.has(form)) { resubmitting.delete(form); return; }
    const input = form.querySelector('input[type="file"][name="document"], input[type="file"][name="form137Scan"]');
    if (!input || !input.files?.length) return;
    if (checked.get(input) === input.files[0]) return;
    event.preventDefault();
    const chosen = input.files[0];
    inspect(input).then((valid) => {
      if (!valid) { input.focus(); return; }
      resubmitting.add(form);
      form.requestSubmit(event.submitter || undefined);
    }).catch(() => {
      if (input.files?.[0] === chosen) feedback(input, 'The file could not be checked. Choose another file.');
      input.focus();
    });
  }, true);
})();
