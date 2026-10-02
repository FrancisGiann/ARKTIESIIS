(() => {
  const page = document.querySelector('.student-documents-page');
  if (!page) return;

  const panels = [...page.querySelectorAll('[data-section-panel]')];
  const links = [...page.querySelectorAll('[data-student-document-section]')];
  const hashTarget = () => {
    if (!window.location.hash) return null;
    let targetId;
    try {
      targetId = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return null;
    }
    return document.getElementById(targetId);
  };
  const sectionFromHash = () => hashTarget()?.closest('[data-section-panel]')?.dataset.sectionPanel || null;

  const showSection = (section) => {
    const active = panels.some((panel) => panel.dataset.sectionPanel === section) ? section : 'digital';
    panels.forEach((panel) => { panel.hidden = panel.dataset.sectionPanel !== active; });
    links.forEach((link) => {
      const selected = link.dataset.studentDocumentSection === active;
      if (selected) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  };

  const focusHashTarget = () => {
    const target = hashTarget();
    if (!target) return;
    window.requestAnimationFrame(() => {
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
      target.scrollIntoView({ block: 'start' });
    });
  };

  const sectionTargetId = (section) => panels.find((panel) => panel.dataset.sectionPanel === section)
    ?.querySelector('h2[id]')?.id || null;

  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      const section = link.dataset.studentDocumentSection;
      const targetId = sectionTargetId(section);
      if (!targetId) return;
      event.preventDefault();
      const nextUrl = `${window.location.pathname}${window.location.search}#${encodeURIComponent(targetId)}`;
      window.history.pushState(null, '', nextUrl);
      showSection(section);
      focusHashTarget();
    });
  });

  const querySection = new URLSearchParams(window.location.search).get('section');
  showSection(sectionFromHash() || querySection || page.dataset.activeSection || 'digital');
  focusHashTarget();
  window.addEventListener('hashchange', () => {
    showSection(sectionFromHash() || page.dataset.activeSection || 'digital');
    focusHashTarget();
  });
  window.addEventListener('popstate', () => {
    showSection(sectionFromHash() || new URLSearchParams(window.location.search).get('section') || page.dataset.activeSection || 'digital');
    focusHashTarget();
  });
})();
