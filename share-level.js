// Pocket Putt — custom level share modal (short via TinyURL / long permanent).
// True viewport overlay (same shell as editor Import). Depends on window.Shared.
(function (root) {
  'use strict';

  const S = root.Shared;
  if (!S) {
    console.error('share-level.js requires shared.js first');
    return;
  }

  const CACHE_PREFIX = 'pp_lvl_short_';
  /** Inline shell styles so a missing/stale CSS sheet cannot leave the dialog in document flow. */
  const OVERLAY_STYLE = {
    position: 'fixed',
    top: '0',
    right: '0',
    bottom: '0',
    left: '0',
    inset: '0',
    zIndex: '10000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
    margin: '0',
    boxSizing: 'border-box',
    background: 'rgba(0, 0, 0, 0.55)',
    WebkitBackdropFilter: 'blur(2px)',
    backdropFilter: 'blur(2px)',
  };
  const CARD_STYLE = {
    position: 'relative',
    zIndex: '1',
    width: 'min(420px, 100%)',
    maxWidth: '420px',
    margin: '0',
    background: '#1e2e22',
    borderRadius: '12px',
    padding: '20px 22px',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    textAlign: 'left',
    boxSizing: 'border-box',
  };

  let modalEl = null;
  let cardEl = null;
  let statusEl = null;
  let urlPreviewEl = null;
  let urlLabelEl = null;
  let shortBtn = null;
  let longBtn = null;
  let pendingLvl = null;
  let busy = false;
  let wired = false;

  function cacheKey(lvl) {
    let h = 2166136261;
    for (let i = 0; i < lvl.length; i++) {
      h ^= lvl.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return CACHE_PREFIX + (h >>> 0).toString(36) + '_' + lvl.length;
  }

  function readCachedAlias(lvl) {
    try {
      const a = sessionStorage.getItem(cacheKey(lvl));
      return S.isValidTinyAlias(a) ? a : null;
    } catch {
      return null;
    }
  }

  function writeCachedAlias(lvl, alias) {
    try {
      sessionStorage.setItem(cacheKey(lvl), alias);
    } catch {
      /* private mode */
    }
  }

  function pageBaseHref() {
    return location.href;
  }

  function applyStyles(el, styles) {
    if (!el) return;
    for (const k of Object.keys(styles)) {
      el.style[k] = styles[k];
    }
  }

  function clearInlineDisplay(el) {
    if (el) el.style.display = '';
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    try {
      if (!document.execCommand('copy')) throw new Error('clipboard unavailable');
    } finally {
      document.body.removeChild(ta);
    }
  }

  function modalInnerHtml() {
    return (
      '<div class="pp-modal-card share-modal-card editor-modal-card" role="document" data-share-card="1">' +
      '<h2 id="share-modal-title">Share level</h2>' +
      '<p class="share-modal-lead">Choose a link to copy. Friends open it in any browser.</p>' +
      '<div class="share-option" data-kind="short">' +
      '<div class="share-option-text">' +
      '<strong class="share-option-title">Short link</strong>' +
      '<span class="share-option-desc">Compact for chat. Uses TinyURL under the hood (may not last forever).</span>' +
      '</div>' +
      '<button type="button" id="btn-share-short" class="btn-small">Copy short</button>' +
      '</div>' +
      '<div class="share-option" data-kind="long">' +
      '<div class="share-option-text">' +
      '<strong class="share-option-title">Permanent link</strong>' +
      '<span class="share-option-desc">Longer URL with the full level baked in. Always works.</span>' +
      '</div>' +
      '<button type="button" id="btn-share-long" class="btn-small">Copy permanent</button>' +
      '</div>' +
      '<p id="share-modal-status" class="share-modal-status" aria-live="assertive"></p>' +
      '<label id="share-url-label" class="share-url-label hidden" for="share-modal-url">Copied link</label>' +
      '<input type="text" id="share-modal-url" class="share-modal-url hidden" readonly spellcheck="false">' +
      '<div class="modal-actions">' +
      '<button type="button" id="btn-share-close" class="btn-small">Close</button>' +
      '</div>' +
      '</div>'
    );
  }

  /**
   * Always mount as a direct child of <body> so no transformed ancestor
   * can trap position:fixed into a local box.
   */
  function mountOnBody(el) {
    if (el.parentNode !== document.body) {
      document.body.appendChild(el);
    }
  }

  function ensureModal() {
    modalEl = document.getElementById('share-modal');
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = 'share-modal';
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('aria-labelledby', 'share-modal-title');
      modalEl.innerHTML = modalInnerHtml();
      document.body.appendChild(modalEl);
    } else {
      // Repair incomplete markup (e.g. partial deploy / old cache).
      if (!modalEl.querySelector('[data-share-card], .share-modal-card, .pp-modal-card')) {
        modalEl.innerHTML = modalInnerHtml();
      }
      mountOnBody(modalEl);
    }

    // Classes: editor-modal is the proven import-dialog shell; pp-modal is the shared alias.
    modalEl.className = 'pp-modal editor-modal hidden';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-labelledby', 'share-modal-title');

    cardEl =
      modalEl.querySelector('[data-share-card]') ||
      modalEl.querySelector('.share-modal-card') ||
      modalEl.querySelector('.pp-modal-card') ||
      modalEl.firstElementChild;

    statusEl = document.getElementById('share-modal-status');
    urlPreviewEl = document.getElementById('share-modal-url');
    urlLabelEl = document.getElementById('share-url-label');
    shortBtn = document.getElementById('btn-share-short');
    longBtn = document.getElementById('btn-share-long');

    if (!wired) {
      wired = true;
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl && !busy) closeShareMenu();
      });
      if (shortBtn) shortBtn.addEventListener('click', () => void onChooseShort());
      if (longBtn) longBtn.addEventListener('click', () => void onChooseLong());
      const closeBtn = document.getElementById('btn-share-close');
      if (closeBtn) closeBtn.addEventListener('click', closeShareMenu);
      if (urlPreviewEl) {
        urlPreviewEl.addEventListener('click', () => {
          try {
            urlPreviewEl.select();
          } catch {
            /* ignore */
          }
        });
      }
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen() && !busy) closeShareMenu();
      });
    }
    return modalEl;
  }

  function isOpen() {
    return !!(modalEl && !modalEl.classList.contains('hidden'));
  }

  function paintOptionRows() {
    if (!modalEl) return;
    modalEl.querySelectorAll('.share-option').forEach((opt) => {
      opt.style.cssText = [
        'display:grid',
        'grid-template-columns:minmax(0,1fr) auto',
        'align-items:center',
        'column-gap:12px',
        'padding:12px',
        'border-radius:10px',
        'background:rgba(0,0,0,0.28)',
        'border:1px solid rgba(255,255,255,0.1)',
        'box-sizing:border-box',
      ].join(';');
      const text = opt.querySelector('.share-option-text');
      if (text) {
        text.style.cssText =
          'display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-width:0;grid-column:1';
      }
      const title = opt.querySelector('.share-option-title, strong');
      if (title) {
        title.style.cssText =
          'display:block;font-size:14px;font-weight:700;color:#eef7ee;line-height:1.3';
      }
      const desc = opt.querySelector('.share-option-desc, span.share-option-desc, .share-option-text > span');
      if (desc) {
        desc.style.cssText =
          'display:block;font-size:12px;line-height:1.4;opacity:0.72;font-weight:400;color:#eef7ee;white-space:normal';
      }
      const btn = opt.querySelector('button');
      if (btn) {
        btn.style.gridColumn = '2';
        btn.style.alignSelf = 'center';
        btn.style.margin = '0';
        btn.style.minWidth = '7.5rem';
        btn.style.whiteSpace = 'nowrap';
      }
    });
    const lead = modalEl.querySelector('.share-modal-lead');
    if (lead) {
      lead.style.cssText =
        'display:block;margin:0 0 4px;font-size:13px;line-height:1.45;opacity:0.75;color:#eef7ee';
    }
    const title = modalEl.querySelector('#share-modal-title, h2');
    if (title) {
      title.style.cssText = 'margin:0;font-size:18px;font-weight:700;color:#eef7ee';
    }
    const actions = modalEl.querySelector('.modal-actions');
    if (actions) {
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px';
    }
  }

  /** Apply fixed overlay styles that cannot be defeated by layout CSS. */
  function paintOpenShell() {
    applyStyles(modalEl, OVERLAY_STYLE);
    modalEl.style.setProperty('display', 'flex', 'important');
    modalEl.style.setProperty('position', 'fixed', 'important');
    modalEl.style.setProperty('z-index', '10000', 'important');
    if (cardEl) applyStyles(cardEl, CARD_STYLE);
    paintOptionRows();
  }

  function paintClosedShell() {
    if (!modalEl) return;
    // Keep position fixed even when closed so reopening never flash-layouts in flow.
    applyStyles(modalEl, OVERLAY_STYLE);
    modalEl.style.setProperty('display', 'none', 'important');
    if (cardEl) applyStyles(cardEl, CARD_STYLE);
  }

  function setBusy(on) {
    busy = !!on;
    if (shortBtn) shortBtn.disabled = !!on;
    if (longBtn) longBtn.disabled = !!on;
  }

  function clearOptionState() {
    if (!modalEl) return;
    modalEl.querySelectorAll('.share-option').forEach((el) => {
      el.classList.remove('is-copied', 'is-busy');
    });
    if (shortBtn) {
      shortBtn.disabled = false;
      shortBtn.textContent = 'Copy short';
    }
    if (longBtn) {
      longBtn.disabled = false;
      longBtn.textContent = 'Copy permanent';
    }
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.remove('is-ok', 'is-error', 'is-pending');
    if (kind === 'ok') statusEl.classList.add('is-ok');
    else if (kind === 'error') statusEl.classList.add('is-error');
    else if (kind === 'pending') statusEl.classList.add('is-pending');
  }

  function setUrlPreview(url, labelText) {
    if (!urlPreviewEl || !urlLabelEl) return;
    if (!url) {
      urlPreviewEl.classList.add('hidden');
      urlLabelEl.classList.add('hidden');
      urlPreviewEl.value = '';
      return;
    }
    urlLabelEl.textContent = labelText || 'Copied link';
    urlLabelEl.classList.remove('hidden');
    urlPreviewEl.value = url;
    urlPreviewEl.classList.remove('hidden');
    try {
      urlPreviewEl.focus();
      urlPreviewEl.select();
    } catch {
      /* ignore */
    }
  }

  function openShareMenu(lvl) {
    if (typeof lvl !== 'string' || !lvl) {
      console.warn('openShareMenu: missing lvl');
      return;
    }
    pendingLvl = lvl;
    ensureModal();
    mountOnBody(modalEl);
    clearOptionState();
    setBusy(false);
    setStatus('', '');
    setUrlPreview('');
    modalEl.classList.remove('hidden');
    paintOpenShell();
    if (shortBtn) shortBtn.focus();
  }

  function closeShareMenu() {
    if (!modalEl) return;
    modalEl.classList.add('hidden');
    paintClosedShell();
    pendingLvl = null;
    busy = false;
    clearOptionState();
    setStatus('', '');
    setUrlPreview('');
  }

  function markCopied(kind, url) {
    const option = modalEl.querySelector('.share-option[data-kind="' + kind + '"]');
    if (option) option.classList.add('is-copied');
    const btn = kind === 'short' ? shortBtn : longBtn;
    if (btn) btn.textContent = '✓ Copied';
    setUrlPreview(url, 'On your clipboard — paste anywhere (or select to re-copy)');
    setStatus(
      kind === 'short' ? 'Short link copied to clipboard.' : 'Permanent link copied to clipboard.',
      'ok'
    );
    setBusy(false);
  }

  async function onChooseLong() {
    if (busy || !pendingLvl) return;
    setBusy(true);
    const option = modalEl.querySelector('.share-option[data-kind="long"]');
    if (option) option.classList.add('is-busy');
    if (longBtn) longBtn.textContent = 'Copying…';
    setStatus('Copying permanent link…', 'pending');
    setUrlPreview('');
    try {
      const url = S.buildLongLevelUrl(pendingLvl, pageBaseHref());
      await copyText(url);
      if (option) option.classList.remove('is-busy');
      markCopied('long', url);
    } catch (e) {
      if (option) option.classList.remove('is-busy');
      if (longBtn) longBtn.textContent = 'Copy permanent';
      try {
        const url = S.buildLongLevelUrl(pendingLvl, pageBaseHref());
        setUrlPreview(url, 'Clipboard blocked — select and press ⌘C / Ctrl+C');
        setStatus('Could not write clipboard automatically. Copy the link below.', 'error');
      } catch (e2) {
        setStatus('Copy failed: ' + (e && e.message ? e.message : e), 'error');
      }
      setBusy(false);
    }
  }

  async function createShortShareUrl(lvl) {
    const cached = readCachedAlias(lvl);
    if (cached) return S.buildShortLevelUrl(cached, pageBaseHref());
    const longUrl = S.buildLongLevelUrl(lvl, pageBaseHref());
    const api = S.TINYURL_CREATE_API + '?url=' + encodeURIComponent(longUrl);
    const res = await fetch(api, { method: 'GET', mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('TinyURL HTTP ' + res.status);
    const text = (await res.text()).trim();
    const alias = S.extractTinyAlias(text);
    if (!alias) throw new Error('unexpected TinyURL response');
    writeCachedAlias(lvl, alias);
    return S.buildShortLevelUrl(alias, pageBaseHref());
  }

  async function onChooseShort() {
    if (busy || !pendingLvl) return;
    setBusy(true);
    const option = modalEl.querySelector('.share-option[data-kind="short"]');
    if (option) option.classList.add('is-busy');
    if (shortBtn) shortBtn.textContent = 'Creating…';
    setStatus('Creating short link…', 'pending');
    setUrlPreview('');
    try {
      const url = await createShortShareUrl(pendingLvl);
      await copyText(url);
      if (option) option.classList.remove('is-busy');
      markCopied('short', url);
    } catch (e) {
      if (option) option.classList.remove('is-busy');
      if (shortBtn) shortBtn.textContent = 'Copy short';
      const detail = e && e.message ? e.message : String(e);
      setStatus('Short link failed (' + detail + '). Try permanent instead.', 'error');
      setBusy(false);
    }
  }

  function showResolveSplash(text) {
    try {
      let splash = document.getElementById('lvl-short-resolving');
      if (!splash) {
        splash = document.createElement('div');
        splash.id = 'lvl-short-resolving';
        splash.className = 'lvl-short-resolving';
        document.body.appendChild(splash);
      }
      splash.textContent = text || 'Opening shared level…';
      return splash;
    } catch {
      return null;
    }
  }

  function hasLvlShortParam(searchParams) {
    const params = searchParams || new URLSearchParams(location.search);
    if ((params.get(S.LVL_PARAM) || '').trim()) return false;
    const alias = (params.get(S.LVL_SHORT_PARAM) || '').trim();
    return !!(alias && S.isValidTinyAlias(alias));
  }

  /**
   * Resolve ?lvl_short=alias to the permanent ?lvl= URL.
   *
   * Prefer same-origin /api/expand-lvl-short (server follows TinyURL, including
   * preview/deprecated interstitials that break browser location.replace).
   * Fall back to navigating to tinyurl.com/alias only if the API is unavailable.
   *
   * @returns {boolean} true if a short-link resolve was started (caller should skip boot)
   */
  function resolveLvlShortFromLocation(searchParams) {
    const params = searchParams || new URLSearchParams(location.search);
    if ((params.get(S.LVL_PARAM) || '').trim()) return false;
    const alias = (params.get(S.LVL_SHORT_PARAM) || '').trim();
    if (!alias) return false;
    if (!S.isValidTinyAlias(alias)) {
      console.warn('Invalid lvl_short alias');
      return false;
    }

    showResolveSplash('Opening shared level…');

    const apiUrl = '/api/expand-lvl-short?alias=' + encodeURIComponent(alias);
    // Async resolve — return true immediately so game.js does not finish boot
    // with an empty custom level.
    void (async () => {
      try {
        const res = await fetch(apiUrl, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok && data.lvl) {
            const longUrl = S.buildLongLevelUrl(data.lvl, pageBaseHref());
            showResolveSplash('Loading level…');
            location.replace(longUrl);
            return;
          }
          if (data && data.ok && data.url && S.extractLvlFromUrl(data.url)) {
            location.replace(data.url);
            return;
          }
        }
        // API present but expand failed — surface error instead of silent TinyURL hop
        // when we know the alias is bad.
        if (res.status === 422) {
          const data = await res.json().catch(() => null);
          showResolveSplash(
            'Could not open short link' +
              (data && data.error ? ' (' + data.error + ')' : '') +
              '. Try the permanent link instead.'
          );
          return;
        }
      } catch {
        /* API unreachable (static host / offline) — fall through */
      }

      // Last resort: browser hop through TinyURL (works for short targets; long
      // levels often hit preview pages and may fail — API is preferred).
      showResolveSplash('Opening short link…');
      location.replace(S.tinyurlExpandUrl(alias));
    })();

    return true;
  }

  // Pre-mount closed shell so first open never paints in-flow.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        ensureModal();
        paintClosedShell();
      });
    } else {
      ensureModal();
      paintClosedShell();
    }
  }

  root.ShareLevel = {
    openShareMenu,
    closeShareMenu,
    createShortShareUrl,
    resolveLvlShortFromLocation,
    hasLvlShortParam,
    isOpen,
    buildLongLevelUrl: (lvl) => S.buildLongLevelUrl(lvl, pageBaseHref()),
    buildShortLevelUrl: (alias) => S.buildShortLevelUrl(alias, pageBaseHref()),
  };
})(typeof self !== 'undefined' ? self : this);
