'use strict';

(function attach(root, factory) {
  const initialize = factory();
  if (typeof module === 'object' && module.exports) module.exports = { initialize };
  if (root?.document && root?.window) initialize({ document: root.document, window: root.window });
})(typeof globalThis === 'object' ? globalThis : this, function makeInitializer() {
  function initialize({ document, window,
    setTimeout: schedule = window.setTimeout.bind(window), clearTimeout: cancelSchedule = window.clearTimeout.bind(window),
    queueMicrotask: queue = window.queueMicrotask?.bind(window) || queueMicrotask, now = Date.now } = {}) {
    const baselines = new Map();
    const forcedDirty = new WeakSet();
    const fileIdentities = new WeakMap();
    let nextFileIdentity = 1;
    let approvedNavigation = null;
    let approvalTimer = null;
    let confirmationPending = false;
    let pendingApprovedSubmission = null;

    function relevantForms() {
      return [...document.querySelectorAll('form')].filter((form) => {
        const method = String(form.method || form.getAttribute?.('method') || 'get').toLowerCase();
        return method !== 'get' && !form.hasAttribute?.('data-ignore-unsaved-changes');
      });
    }

    function controlsFor(form) {
      return [...form.querySelectorAll('input, select, textarea')].filter((control) => {
        if (control.disabled || control.readOnly) return false;
        if (control.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(String(control.type).toLowerCase())) return false;
        return true;
      });
    }

    function fileIdentity(file) {
      if (!file || typeof file !== 'object') return '';
      if (!fileIdentities.has(file)) fileIdentities.set(file, nextFileIdentity++);
      return fileIdentities.get(file);
    }

    function snapshot(form) {
      return JSON.stringify(controlsFor(form).map((control) => {
        const tag = String(control.tagName || '').toUpperCase();
        const type = String(control.type || '').toLowerCase();
        const value = type === 'file'
          ? [...(control.files || [])].map((file) => [fileIdentity(file), file.name, file.size, file.lastModified, file.type])
          : (type === 'checkbox' || type === 'radio')
            ? [control.checked, control.value]
            : tag === 'SELECT' && control.multiple
              ? [...(control.selectedOptions || [])].map((option) => option.value)
              : control.value;
        return [control.name || control.id || '', value];
      }));
    }

    function register(form) {
      if (baselines.has(form) || !relevantForms().includes(form)) return;
      baselines.set(form, snapshot(form));
      if (form.hasAttribute?.('data-unsaved-initially-dirty')) forcedDirty.add(form);
    }

    function dirty(form) {
      register(form);
      return forcedDirty.has(form) || baselines.get(form) !== snapshot(form);
    }

    function dirtyForms(except = null) {
      return relevantForms().filter((form) => form !== except && dirty(form));
    }

    function clearApproval() {
      approvedNavigation = null;
      if (approvalTimer !== null) cancelSchedule(approvalTimer);
      approvalTimer = null;
    }

    function approveNavigation(event = null) {
      clearApproval();
      const approval = { expiresAt: now() + 1500 };
      approvedNavigation = approval;
      approvalTimer = schedule(() => {
        if (approvedNavigation === approval) clearApproval();
      }, 1500);
      if (event) queue(() => {
        if (event.defaultPrevented && approvedNavigation === approval) clearApproval();
      });
    }

    function isSamePageNavigation(anchor) {
      try {
        const target = new URL(anchor.href, window.location.href);
        const current = new URL(window.location.href);
        return target.origin === current.origin && target.pathname === current.pathname
          && target.search === current.search && Boolean(target.hash);
      } catch {
        return false;
      }
    }

    function preventEvent(event) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
    }

    function confirmationMessage(form, hasOtherDirtyForms) {
      const actionMessage = form?.getAttribute?.('data-confirm-message')?.trim();
      if (actionMessage && hasOtherDirtyForms) return `${actionMessage} This will also discard unsaved changes in another form.`;
      if (actionMessage) return actionMessage;
      if (form?.hasAttribute?.('data-confirm')) return 'Continue with this action?';
      if (form && hasOtherDirtyForms) {
        const action = form.action || form.getAttribute?.('action') || '';
        if (/\/logout(?:[?#]|$)/i.test(action)) return 'Sign out and discard unsaved changes in another form?';
        return 'Save this form and discard unsaved changes in another form?';
      }
      return 'Leave this page and discard your unsaved changes?';
    }

    function confirmationOptions(form, hasOtherDirtyForms) {
      const actionMessage = form?.getAttribute?.('data-confirm-message');
      return {
        title: form?.getAttribute?.('data-confirm-title') || (actionMessage ? 'Confirm this action' : 'Unsaved changes'),
        confirmLabel: form?.getAttribute?.('data-confirm-accept-label') || (hasOtherDirtyForms
          ? (/\/logout(?:[?#]|$)/i.test(form.action || form.getAttribute?.('action') || '') ? 'Sign out' : 'Save and continue')
          : (actionMessage ? 'Confirm' : 'Leave page'))
      };
    }

    function askForConfirmation(message, options) {
      if (typeof window.appConfirm === 'function') {
        try { return Promise.resolve(window.appConfirm(message, options)); }
        catch { announceUnavailable(); return Promise.resolve(false); }
      }
      announceUnavailable();
      return Promise.resolve(false);
    }

    function announceUnavailable() {
      if (!document.body?.append || typeof document.createElement !== 'function') return;
      let notice = document.getElementById('app-confirm-unavailable');
      if (!notice) {
        notice = document.createElement('p');
        notice.id = 'app-confirm-unavailable';
        notice.className = 'app-confirm-dialog__fallback';
        notice.setAttribute('role', 'alert');
        notice.setAttribute('tabindex', '-1');
        document.body.append(notice);
      }
      notice.textContent = 'This action was canceled because a confirmation could not be opened. Your changes are still here.';
      notice.focus?.();
    }

    function beginAsyncConfirmation(event, { form = null, anchor = null, submitter = null, otherDirtyForms = false } = {}) {
      preventEvent(event);
      if (confirmationPending) return;
      confirmationPending = true;
      const message = confirmationMessage(form, otherDirtyForms);
      const options = confirmationOptions(form, otherDirtyForms);
      const originalHref = anchor?.href;
      const originalSubmission = form ? {
        action: form.action || form.getAttribute?.('action') || window.location.href,
        method: String(form.method || form.getAttribute?.('method') || 'get').toLowerCase(),
        submitterAction: submitter?.formAction || submitter?.getAttribute?.('formaction') || '',
        submitterMethod: submitter?.formMethod || submitter?.getAttribute?.('formmethod') || '',
        formTarget: form.getAttribute?.('target') || '',
        submitterTarget: submitter?.formTarget || submitter?.getAttribute?.('formtarget') || '',
        submitterName: submitter?.name || '',
        submitterValue: submitter?.value ?? ''
      } : null;
      askForConfirmation(message, options).then((accepted) => {
        if (!accepted) return;
        if (anchor) {
          if (anchor.isConnected === false || anchor.href !== originalHref) return;
          confirmationPending = false;
          approveNavigation();
          try { window.location.assign(originalHref); }
          catch { clearApproval(); }
          return;
        }
        if (!form || form.isConnected === false) return;
        if (submitter && (submitter.isConnected === false || (submitter.form && submitter.form !== form))) return;
        if (originalSubmission) {
          const currentSubmission = {
            action: form.action || form.getAttribute?.('action') || window.location.href,
            method: String(form.method || form.getAttribute?.('method') || 'get').toLowerCase(),
            submitterAction: submitter?.formAction || submitter?.getAttribute?.('formaction') || '',
            submitterMethod: submitter?.formMethod || submitter?.getAttribute?.('formmethod') || '',
            formTarget: form.getAttribute?.('target') || '',
            submitterTarget: submitter?.formTarget || submitter?.getAttribute?.('formtarget') || '',
            submitterName: submitter?.name || '',
            submitterValue: submitter?.value ?? ''
          };
          if (Object.keys(originalSubmission).some((key) => originalSubmission[key] !== currentSubmission[key])) return;
        }
        confirmationPending = false;
        const approved = { form, submitter };
        pendingApprovedSubmission = approved;
        try {
          if (submitter) form.requestSubmit(submitter);
          else form.requestSubmit();
        } catch {
          if (pendingApprovedSubmission === approved) pendingApprovedSubmission = null;
        }
        schedule(() => {
          if (pendingApprovedSubmission === approved) pendingApprovedSubmission = null;
        }, 0);
      }).catch(() => {
        // A failed dialog leaves the user's values in place and protected.
      }).finally(() => { confirmationPending = false; });
    }

    function onClick(event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target?.closest?.('a[href]') || event.target?.parentElement?.closest?.('a[href]');
      if (!target || target.hasAttribute('download')) return;
      if (target.hasAttribute('data-document-preview-trigger') || target.hasAttribute('data-student-document-section')) return;
      const linkTarget = target.getAttribute('target') || '';
      if (linkTarget && linkTarget.toLowerCase() !== '_self') return;
      if (isSamePageNavigation(target)) return;
      let protocol;
      try { protocol = new URL(target.href, window.location.href).protocol; } catch { return; }
      if (!['http:', 'https:'].includes(protocol)) return;
      if (!dirtyForms().length) return;
      beginAsyncConfirmation(event, { anchor: target });
    }

    function onSubmit(event) {
      const form = event.target;
      if (!form || form.tagName !== 'FORM') return;
      if (event.defaultPrevented) return;
      const trackedForm = relevantForms().includes(form);
      register(form);
      const submitter = event.submitter || null;
      const submitterTarget = event.submitter?.getAttribute?.('formtarget') || '';
      const formTarget = form.getAttribute?.('target') || '';
      if ([submitterTarget, formTarget].some((target) => target && target.toLowerCase() !== '_self')) return;
      if (pendingApprovedSubmission?.form === form && pendingApprovedSubmission.submitter === submitter) {
        pendingApprovedSubmission = null;
        if (dirtyForms(form).length || dirty(form)) approveNavigation(event);
        return;
      }
      if (confirmationPending) { preventEvent(event); return; }
      const actionNeedsConfirmation = form.hasAttribute?.('data-confirm');
      const otherDirtyForms = dirtyForms(form).length > 0 || (!trackedForm && dirtyForms().length > 0);
      if (actionNeedsConfirmation || otherDirtyForms) {
        beginAsyncConfirmation(event, { form, submitter, otherDirtyForms });
        return;
      }
      if (!trackedForm) {
        return;
      }
      if (dirty(form)) approveNavigation(event);
      queue(() => {
        if (event.defaultPrevented && approvedNavigation) clearApproval();
      });
    }

    function onBeforeUnload(event) {
      if (approvedNavigation && approvedNavigation.expiresAt >= now()) {
        clearApproval();
        return;
      }
      if (!dirtyForms().length) return;
      event.preventDefault();
      event.returnValue = '';
    }

    function focusServerErrors() {
      const form = document.querySelector('form[data-error-fields]');
      if (!form) return;
      const links = [...document.querySelectorAll('[data-error-target]')];
      for (const link of links) {
        const targetId = link.getAttribute('href')?.slice(1);
        const target = targetId ? document.getElementById(targetId) : null;
        if (!target) continue;
        target.setAttribute('aria-invalid', 'true');
        target.dataset.invalidField = 'true';
        const label = target.closest?.('label');
        if (label?.classList?.contains('pre-enrollment-form-check')) label.dataset.invalidField = 'true';
        let parent = target.parentElement;
        while (parent && parent !== form) {
          if (parent.tagName === 'DETAILS') parent.open = true;
          if (parent.hidden) parent.hidden = false;
          parent = parent.parentElement;
        }
      }
      const summary = document.getElementById('pre-enrollment-error-summary');
      if (summary) {
        const firstLink = summary.querySelector('[data-error-target]');
        (firstLink || summary).focus();
      }
    }

    function registerFormsWithin(node) {
      if (node?.tagName === 'FORM') register(node);
      for (const form of node?.querySelectorAll?.('form') || []) register(form);
    }

    function captureInitialState() {
      for (const form of relevantForms()) register(form);
      focusServerErrors();
    }

    function onFocusIn(event) {
      const form = event.target?.closest?.('form');
      if (form) register(form);
    }
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pageshow', clearApproval);
    window.addEventListener('pagehide', clearApproval);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', captureInitialState, { once: true });
    else captureInitialState();
    const observer = typeof window.MutationObserver === 'function' && document.documentElement
      ? new window.MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes || []) registerFormsWithin(node);
      })
      : null;
    observer?.observe(document.documentElement, { childList: true, subtree: true });

    return {
      dirtyForms,
      refreshBaseline(form) { baselines.set(form, snapshot(form)); forcedDirty.delete(form); },
      destroy() {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('submit', onSubmit, true);
        document.removeEventListener('focusin', onFocusIn, true);
        window.removeEventListener('beforeunload', onBeforeUnload);
        window.removeEventListener('pageshow', clearApproval);
        window.removeEventListener('pagehide', clearApproval);
        observer?.disconnect();
        clearApproval();
      }
    };
  }

  return initialize;
});
