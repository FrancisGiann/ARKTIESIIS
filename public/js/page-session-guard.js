(() => {
  const body = document.body;
  const binding = body?.dataset.pageSessionBinding;
  const dialog = document.getElementById('page-session-dialog');
  const title = document.getElementById('page-session-title');
  const message = document.getElementById('page-session-message');
  const action = document.getElementById('page-session-action');
  if (!body || !/^[a-f0-9]{64}$/.test(binding || '') || !dialog || !title || !message || !action) return;

  let inFlight = null;
  let activeController = null;
  let requestSequence = 0;
  let pageSuspended = false;
  let terminal = false;
  let blockedUnavailable = false;
  let heartbeatTimer = null;
  let pageGateActive = document.documentElement.dataset.pageSessionState === 'checking';

  if (!pageGateActive) {
    try { window.sessionStorage.setItem('arktiesiis:page-session-binding', binding); } catch { /* The server check remains authoritative without tab storage. */ }
  }

  function setPageState(state) {
    body.dataset.pageSessionState = state;
  }

  function clearEarlyPageGate() {
    document.documentElement.removeAttribute('data-page-session-state');
  }

  function openDialog() {
    if (dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog() {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  function showChecking() {
    pageGateActive = true;
    setPageState('checking');
    title.textContent = 'Checking your session';
    message.textContent = 'Please wait while we check your sign-in.';
    action.textContent = 'Checking…';
    action.disabled = true;
    openDialog();
  }

  function showEnded() {
    if (pageSuspended || document.hidden) return;
    terminal = true;
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
    clearEarlyPageGate();
    setPageState('revoked');
    title.textContent = 'Your session ended';
    message.textContent = 'Your session ended. Please sign in again.';
    action.textContent = 'Sign in';
    action.disabled = false;
    action.onclick = () => window.location.replace('/login');
    openDialog();
  }

  function showUnavailable() {
    if (pageSuspended || document.hidden) return;
    if (!pageGateActive) return;
    blockedUnavailable = true;
    clearEarlyPageGate();
    setPageState('unavailable');
    title.textContent = 'Session check unavailable';
    message.textContent = "We couldn't verify your session. Retry to continue.";
    action.textContent = 'Retry';
    action.disabled = false;
    action.onclick = () => {
      blockedUnavailable = false;
      void checkSession(true, true);
    };
    openDialog();
  }

  function showVerified() {
    if (pageSuspended || document.hidden || terminal) return;
    blockedUnavailable = false;
    pageGateActive = false;
    clearEarlyPageGate();
    setPageState('verified');
    closeDialog();
  }

  function handleCheckResult(response, result, requestId) {
    if (requestId !== requestSequence || pageSuspended || document.hidden) return;
    if (response.status === 401) return showEnded();
    if (!response.ok || !result || result.valid !== true) return showUnavailable();
    showVerified();
  }

  async function checkSession(hideUntilSuccess = false, userRetry = false) {
    if (document.hidden || pageSuspended || terminal || blockedUnavailable && !userRetry) return;
    if (inFlight) {
      if (hideUntilSuccess) showChecking();
      return inFlight;
    }
    if (hideUntilSuccess) showChecking();

    const requestId = ++requestSequence;
    const controller = new AbortController();
    activeController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    const request = (async () => {
      try {
        const response = await fetch('/session/check', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'X-Page-Session-Binding': binding
          }
        });
        let result = null;
        try { result = await response.json(); } catch { /* Non-JSON responses are unavailable. */ }
        handleCheckResult(response, result, requestId);
      } catch {
        if (requestId === requestSequence && !pageSuspended && !document.hidden) showUnavailable();
      } finally {
        window.clearTimeout(timeout);
        if (requestId === requestSequence) {
          inFlight = null;
          activeController = null;
        }
      }
    })();
    inFlight = request;
    return request;
  }

  dialog.addEventListener('cancel', (event) => event.preventDefault());

  function abortSessionCheck() {
    if (!activeController) return;
    requestSequence += 1;
    activeController.abort();
    activeController = null;
    inFlight = null;
  }

  heartbeatTimer = window.setInterval(() => {
    if (!document.hidden) void checkSession();
  }, 2000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      abortSessionCheck();
      return;
    }
    void checkSession(pageGateActive);
  });

  window.addEventListener('pagehide', () => {
    pageSuspended = true;
    pageGateActive = true;
    abortSessionCheck();
    setPageState('checking');
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    pageSuspended = false;
    pageGateActive = true;
    void checkSession(true);
  });

  void checkSession(pageGateActive);
})();
