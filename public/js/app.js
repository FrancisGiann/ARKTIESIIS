for (const button of document.querySelectorAll('[data-print-page]')) {
  button.addEventListener('click', () => window.print());
}

for (const form of document.querySelectorAll('form[data-clear-section-on-term-change]')) {
  const term = form.querySelector('select[name="termId"]');
  const section = form.querySelector('select[name="sectionId"]');
  const assignment = form.hasAttribute('data-clear-assignment-on-section-change')
    ? form.querySelector('select[name="assignmentId"]') : null;
  if (!term || !section) continue;

  term.addEventListener('change', () => {
    section.value = '';
    if (assignment) assignment.value = '';
  });
  if (assignment) {
    section.addEventListener('change', () => { assignment.value = ''; });
  }
}

for (const form of document.querySelectorAll('[data-password-match-form]')) {
  const password = form.querySelector('[data-password-source]');
  const confirmation = form.querySelector('[data-password-confirm]');
  const message = form.querySelector('[data-password-mismatch-message]');

  if (!password || !confirmation || !message) continue;

  let mismatchFeedbackEnabled = false;

  const updateMismatch = () => {
    const hasBothValues = password.value.length > 0 && confirmation.value.length > 0;
    const mismatch = mismatchFeedbackEnabled && hasBothValues && password.value !== confirmation.value;

    confirmation.setAttribute('aria-invalid', String(mismatch));
    message.textContent = mismatch
      ? 'Passwords do not match. Enter the same password in both fields.'
      : '';
  };

  password.addEventListener('input', updateMismatch);
  confirmation.addEventListener('input', updateMismatch);
  confirmation.addEventListener('blur', () => {
    if (password.value.length > 0 && confirmation.value.length > 0) {
      mismatchFeedbackEnabled = true;
    }
    updateMismatch();
  });

  form.addEventListener('submit', (event) => {
    mismatchFeedbackEnabled = true;
    updateMismatch();
    if (password.value === confirmation.value) return;

    event.preventDefault();
    confirmation.focus();
  });
}

for (const form of document.querySelectorAll('form[method="post"]')) {
  const submitters = form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]');
  if (!submitters.length) continue;

  const status = document.createElement('p');
  status.className = 'submission-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  status.hidden = true;
  form.append(status);

  form.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    if (form.dataset.submitting === 'true') {
      event.preventDefault();
      return;
    }

    form.dataset.submitting = 'true';
    form.setAttribute('aria-busy', 'true');
    status.hidden = false;
    status.textContent = form.dataset.submittingMessage || 'Submitting your request. Please wait.';

    const submitter = event.submitter;
    if (submitter) {
      submitter.setAttribute('aria-disabled', 'true');
      if (submitter.dataset.submittingLabel) {
        submitter.dataset.originalSubmitLabel = submitter.textContent;
        submitter.textContent = submitter.dataset.submittingLabel;
      }
    }
  });
}

window.addEventListener('pageshow', () => {
  for (const form of document.querySelectorAll('form[method="post"]')) {
    if (form.dataset.submitting !== 'true') continue;

    form.dataset.submitting = 'false';
    form.removeAttribute('aria-busy');
    const status = form.querySelector('.submission-status');
    if (status) {
      status.hidden = true;
      status.textContent = '';
    }
    for (const submitter of form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]')) {
      submitter.removeAttribute('aria-disabled');
      if (submitter.dataset.originalSubmitLabel) {
        submitter.textContent = submitter.dataset.originalSubmitLabel;
        delete submitter.dataset.originalSubmitLabel;
      }
    }
  }
});

const documentPreviewDialog = document.querySelector('[data-document-preview-dialog]');

function setupDocumentImageViewer(viewer) {
  const viewport = viewer.querySelector('[data-document-image-viewport]');
  const image = viewer.querySelector('[data-document-image]');
  const zoomStatus = viewer.querySelector('[data-image-zoom-status]');
  const zoomIn = viewer.querySelector('[data-image-zoom-in]');
  const zoomOut = viewer.querySelector('[data-image-zoom-out]');
  const zoomReset = viewer.querySelector('[data-image-zoom-reset]');
  if (!viewport || !image || viewer.dataset.imageViewerReady === 'true') return;

  viewer.dataset.imageViewerReady = 'true';
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let drag = null;
  const minScale = 1;
  const maxScale = 4;

  const panBounds = () => {
    if (!image.naturalWidth || !image.naturalHeight) return { x: 0, y: 0 };
    const fit = Math.min(viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight);
    return {
      x: Math.max(0, (image.naturalWidth * fit * scale - viewport.clientWidth) / 2),
      y: Math.max(0, (image.naturalHeight * fit * scale - viewport.clientHeight) / 2)
    };
  };

  const render = () => {
    const bounds = panBounds();
    offsetX = Math.max(-bounds.x, Math.min(bounds.x, offsetX));
    offsetY = Math.max(-bounds.y, Math.min(bounds.y, offsetY));
    image.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${scale})`;
    image.classList.toggle('is-zoomed', scale > minScale);
    viewport.classList.toggle('is-pannable', scale > minScale);
    if (zoomStatus) zoomStatus.textContent = `Zoom ${Math.round(scale * 100)}%`;
    if (zoomIn) zoomIn.disabled = scale >= maxScale;
    if (zoomOut) zoomOut.disabled = scale <= minScale;
    if (zoomReset) zoomReset.disabled = scale === minScale && offsetX === 0 && offsetY === 0;
  };

  const setScale = (nextScale) => {
    scale = Math.max(minScale, Math.min(maxScale, nextScale));
    if (scale === minScale) offsetX = offsetY = 0;
    render();
  };

  zoomIn?.addEventListener('click', () => setScale(scale + 0.5));
  zoomOut?.addEventListener('click', () => setScale(scale - 0.5));
  zoomReset?.addEventListener('click', () => {
    scale = minScale;
    offsetX = offsetY = 0;
    render();
  });
  image.addEventListener('load', () => {
    scale = minScale;
    offsetX = offsetY = 0;
    render();
  });
  viewport.addEventListener('pointerdown', (event) => {
    if (scale <= minScale || event.button !== 0) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX, offsetY };
    viewport.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    offsetX = drag.offsetX + event.clientX - drag.x;
    offsetY = drag.offsetY + event.clientY - drag.y;
    render();
  });
  const endPan = (event) => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    drag = null;
  };
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);
  viewport.addEventListener('keydown', (event) => {
    if (scale <= minScale) return;
    const amount = event.shiftKey ? 80 : 32;
    if (event.key === 'ArrowLeft') offsetX += amount;
    else if (event.key === 'ArrowRight') offsetX -= amount;
    else if (event.key === 'ArrowUp') offsetY += amount;
    else if (event.key === 'ArrowDown') offsetY -= amount;
    else return;
    event.preventDefault();
    render();
  });
  render();
}

for (const viewer of document.querySelectorAll('[data-document-image-viewer]')) setupDocumentImageViewer(viewer);

if (documentPreviewDialog?.querySelector('[data-document-preview-frame]')) {
  const previewFrame = documentPreviewDialog.querySelector('[data-document-preview-frame]');
  const previewImageViewer = documentPreviewDialog.querySelector('[data-document-preview-image-viewer]');
  if (previewImageViewer) setupDocumentImageViewer(previewImageViewer);
  const previewImage = previewImageViewer?.querySelector('[data-document-image]');
  const previewImageView = previewImageViewer?.querySelector('[data-document-image-viewport]');
  const previewTitle = documentPreviewDialog.querySelector('[data-document-preview-title]');
  const closePreviewButton = documentPreviewDialog.querySelector('[data-document-preview-close]');
  let previewTrigger = null;

  const clearDocumentPreview = () => {
    previewFrame.removeAttribute('src');
    previewImage?.removeAttribute('src');
    documentPreviewDialog.classList.remove('document-preview-dialog--image');
    if (previewImageViewer) previewImageViewer.hidden = true;
    previewFrame.hidden = false;
    if (previewImageView) {
      const resetButton = previewImageViewer.querySelector('[data-image-zoom-reset]');
      resetButton?.click();
    }
    if (previewTrigger?.isConnected) previewTrigger.focus();
    previewTrigger = null;
  };

  for (const trigger of document.querySelectorAll('[data-document-preview-trigger]')) {
    trigger.addEventListener('click', (event) => {
      if (typeof documentPreviewDialog.showModal !== 'function' || documentPreviewDialog.open) return;

      let previewUrl;
      try {
        previewUrl = new URL(trigger.href, window.location.href);
      } catch {
        return;
      }

      if (previewUrl.origin !== window.location.origin || !/^\/documents\/\d+\/preview$/.test(previewUrl.pathname)) return;
      const mimeType = trigger.dataset.previewMime;
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)) return;

      event.preventDefault();
      previewTrigger = trigger;
      const filename = trigger.dataset.previewTitle || 'document';
      const isImagePreview = mimeType === 'image/jpeg' || mimeType === 'image/png';
      documentPreviewDialog.classList.toggle('document-preview-dialog--image', isImagePreview);
      previewTitle.textContent = `Preview: ${filename}`;
      if (mimeType === 'application/pdf') {
        previewImage?.removeAttribute('src');
        if (previewImageViewer) previewImageViewer.hidden = true;
        previewFrame.hidden = false;
        previewFrame.title = `Preview of ${filename}`;
        previewFrame.src = previewUrl.href;
      } else {
        previewFrame.removeAttribute('src');
        previewFrame.hidden = true;
        if (previewImageViewer) previewImageViewer.hidden = false;
        if (previewImage) {
          previewImage.alt = `Preview of ${filename}`;
          previewImage.src = previewUrl.href;
        }
      }
      documentPreviewDialog.showModal();
    });
  }

  closePreviewButton?.addEventListener('click', () => documentPreviewDialog.close());
  documentPreviewDialog.addEventListener('close', clearDocumentPreview);
  documentPreviewDialog.addEventListener('click', (event) => {
    if (event.target === documentPreviewDialog) documentPreviewDialog.close();
  });
}
