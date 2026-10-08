(function attachScheduleConflictPreview(root, createApi) {
  const api = createApi();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document && root.fetch && root.AbortController) {
    api.install(root.document, root.fetch.bind(root), root.AbortController);
  }
})(globalThis, function createScheduleConflictPreviewApi() {
  function createPreviewController({ fetchImpl, AbortControllerImpl, onResult, timeoutMs = 8000 }) {
    let requestNumber = 0;
    let activeRequest = null;

    function invalidate() {
      requestNumber += 1;
      if (activeRequest) activeRequest.controller.abort();
      activeRequest = null;
      onResult({ state: 'cleared' });
    }

    async function check(url, payload) {
      if (activeRequest) activeRequest.controller.abort();
      const currentRequest = ++requestNumber;
      const controller = new AbortControllerImpl();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      activeRequest = { controller, requestNumber: currentRequest };
      onResult({ state: 'checking' });

      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        if (!response.ok) throw new Error('Conflict check unavailable.');
        const result = await response.json();
        if (currentRequest !== requestNumber) return;
        if (controller.signal.aborted) {
          if (timedOut) {
            onResult({
              state: 'error',
              message: 'Conflict check unavailable. You can still save; the schedule will be checked again.'
            });
          }
          return;
        }
        if (!result || typeof result !== 'object' || !Array.isArray(result.conflicts)) {
          throw new Error('Conflict check unavailable.');
        }
        onResult({ state: 'complete', result });
      } catch {
        if (currentRequest !== requestNumber) return;
        if (controller.signal.aborted && !timedOut) return;
        onResult({
          state: 'error',
          message: 'Conflict check unavailable. You can still save; the schedule will be checked again.'
        });
      } finally {
        clearTimeout(timeout);
        if (activeRequest?.requestNumber === currentRequest) activeRequest = null;
      }
    }

    return { check, invalidate };
  }

  function validTime(value) {
    return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  function install(document, fetchImpl, AbortControllerImpl) {
    for (const form of document.querySelectorAll('[data-schedule-conflict-form]')) {
      const feedback = form.querySelector('[data-schedule-conflict-feedback]');
      const message = feedback?.querySelector('[data-conflict-message]');
      const list = feedback?.querySelector('[data-conflict-list]');
      const submitButton = form.querySelector('button[type="submit"]');
      if (!feedback || !message || !list || !submitButton) continue;

      let debounce = null;
      const show = (state) => {
        if (state.state === 'cleared') {
          feedback.hidden = true;
          feedback.dataset.state = '';
          feedback.dataset.hasConflicts = 'false';
          message.textContent = '';
          list.replaceChildren();
          return;
        }
        feedback.hidden = false;
        feedback.dataset.state = state.state;
        feedback.dataset.hasConflicts = state.state === 'complete' && state.result.conflict ? 'true' : 'false';
        list.replaceChildren();
        if (state.state === 'checking') {
          message.textContent = 'Checking for schedule conflicts…';
          return;
        }
        if (state.state === 'error') {
          message.textContent = state.message;
          return;
        }

        const result = state.result;
        message.textContent = typeof result.message === 'string'
          ? result.message
          : result.conflict ? 'A schedule conflict was found.' : 'No conflicts were found right now. Saving will check again.';
        for (const conflict of result.conflicts) {
          const item = document.createElement('li');
          item.textContent = typeof conflict.summary === 'string' ? conflict.summary : 'A matching class time was found.';
          list.append(item);
        }
        if (result.conflictsTruncated) {
          const item = document.createElement('li');
          item.textContent = 'More matching class times were found. Adjust the schedule details and check again.';
          list.append(item);
        }
      };

      const controller = createPreviewController({ fetchImpl, AbortControllerImpl, onResult: show });
      const readInput = () => {
        const value = (name) => form.elements.namedItem(name)?.value ?? '';
        const assignmentId = value('assignmentId');
        const dayOfWeek = value('dayOfWeek');
        const startTime = value('startTime');
        const endTime = value('endTime');
        const room = value('room').trim();
        if (!/^[1-9]\d{0,9}$/.test(assignmentId) || !/^[1-6]$/.test(dayOfWeek)
          || !validTime(startTime) || !validTime(endTime)) {
          return { valid: false, reason: '' };
        }
        if (startTime >= endTime) {
          return { valid: false, reason: 'Enter an end time after the start time to check for conflicts.' };
        }
        if (room.length > 80 || /[\u0000-\u001f\u007f]/.test(room)) {
          return { valid: false, reason: 'Enter a room with 80 printable characters or fewer to check for conflicts.' };
        }
        return {
          valid: true,
          payload: {
            _csrf: value('_csrf'),
            scheduleId: value('scheduleId'),
            assignmentId,
            termId: value('termId'),
            filterSectionId: value('filterSectionId'),
            filterAssignmentId: value('filterAssignmentId'),
            dayOfWeek,
            startTime,
            endTime,
            room
          }
        };
      };

      const runCheck = () => {
        const input = readInput();
        if (!input.valid) {
          if (input.reason) show({ state: 'error', message: input.reason });
          return;
        }
        controller.check(form.dataset.conflictPreviewUrl, input.payload);
      };

      const scheduleCheck = () => {
        clearTimeout(debounce);
        controller.invalidate();
        debounce = setTimeout(runCheck, 300);
      };
      form.addEventListener('input', scheduleCheck);
      form.addEventListener('change', scheduleCheck);
      form.querySelector('[data-check-schedule-conflicts]')?.addEventListener('click', () => {
        clearTimeout(debounce);
        controller.invalidate();
        runCheck();
      });
      form.addEventListener('submit', () => {
        clearTimeout(debounce);
        controller.invalidate();
      });
    }
  }

  return { createPreviewController, install };
});
