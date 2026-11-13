(() => {
  const bindingKey = 'arktiesiis:page-session-binding';
  const readPageBinding = () => {
    try {
      const storedBinding = window.sessionStorage.getItem(bindingKey);
      return /^[a-f0-9]{64}$/.test(storedBinding || '') ? storedBinding : null;
    } catch { return null; }
  };
  let pageBinding = readPageBinding();

  const navigation = window.performance?.getEntriesByType?.('navigation')?.[0];
  const isBackForwardNavigation = navigation?.type === 'back_forward';
  if (isBackForwardNavigation && pageBinding) document.documentElement.dataset.authHistoryCheck = 'pending';

  let requestInFlight = false;
  let dialog;
  let title;
  let message;
  let action;

  function initializeElements() {
    if (dialog) return;
    dialog = document.getElementById('auth-history-dialog');
    title = document.getElementById('auth-history-title');
    message = document.getElementById('auth-history-message');
    action = document.getElementById('auth-history-action');
    dialog?.addEventListener('cancel', (event) => event.preventDefault());
  }

  function setState(state) {
    if (document.body) document.body.dataset.authHistoryState = state;
  }

  function closeDialog() {
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    else dialog?.removeAttribute('open');
  }

  function openDialog() {
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function restoreForm() {
    document.documentElement.removeAttribute('data-auth-history-check');
    if (document.body) document.body.removeAttribute('data-auth-history-state');
    closeDialog();
  }

  function showChecking() {
    setState('checking');
    title.textContent = 'Checking your previous sign-in';
    message.textContent = 'Please wait while we end the sign-in from this tab.';
    action.textContent = 'Checking…';
    action.disabled = true;
    openDialog();
  }

  function showUnavailable() {
    setState('unavailable');
    title.textContent = 'Session check unavailable';
    message.textContent = "We couldn't check your previous sign-in. Retry to continue.";
    action.textContent = 'Retry';
    action.disabled = false;
    action.onclick = () => void endRestoredSession();
    openDialog();
  }

  async function endRestoredSession() {
    if (requestInFlight) return;
    requestInFlight = true;
    showChecking();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/session/end-history', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        keepalive: true,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'X-Page-History-Restore': 'end-session',
          'X-Page-Session-Binding': pageBinding
        }
      });
      let result = null;
      try { result = await response.json(); } catch { /* Unexpected non-JSON responses stay hidden. */ }

      if ((response.status === 401 && result?.ended === true) || (response.ok && result?.ended === true)) {
        try { window.sessionStorage.removeItem(bindingKey); } catch { /* The destroyed server session remains authoritative. */ }
        window.location.replace('/login');
        return;
      }
      if (response.status === 409 && result?.mismatch === true) {
        restoreForm();
        return;
      }
      showUnavailable();
    } catch {
      showUnavailable();
    } finally {
      window.clearTimeout(timeout);
      requestInFlight = false;
    }
  }

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted && !isBackForwardNavigation) return;
    pageBinding = readPageBinding();
    if (!pageBinding) {
      restoreForm();
      return;
    }
    initializeElements();
    document.documentElement.dataset.authHistoryCheck = 'pending';
    showChecking();
    void endRestoredSession();
  });
})();
