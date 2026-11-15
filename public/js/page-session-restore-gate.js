(() => {
  let navigationType = '';
  try {
    const navigationEntries = window.performance?.getEntriesByType?.('navigation');
    if (navigationEntries?.length) navigationType = navigationEntries[0].type;
    else if (window.performance?.navigation?.type === 2) navigationType = 'back_forward';
  } catch { /* If navigation state is unavailable, the later heartbeat still checks the page. */ }

  const binding = document.currentScript?.dataset.pageSessionBinding;
  if (navigationType !== 'back_forward' && /^[a-f0-9]{64}$/.test(binding || '')) {
    try { window.sessionStorage.setItem('arktiesiis:page-session-binding', binding); } catch { /* The server check remains authoritative without tab storage. */ }
  }

  if (navigationType === 'back_forward') {
    document.documentElement.dataset.pageSessionState = 'checking';
  }
})();
