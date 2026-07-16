// Pocket Putt — custom level share modal (short via TinyURL / long permanent).
// Matches editor Import modal chrome. Depends on window.Shared.
// Markup: #share-modal in index.html + editor.html (creates a fallback if missing).
(function (root) {
  'use strict';

  const S = root.Shared;
  if (!S) {
    console.error('share-level.js requires shared.js first');
    return;
  }

  const CACHE_PREFIX = 'pp_lvl_short_';
  let modalEl = null;
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

  function modalHtml() {
    return (
      '<div class="pp-modal-card share-modal-card" role="document">' +
      '<h2 id="share-modal-title">Share level</h2>' +
      '<p class="share-modal-lead">Choose a link to copy. Friends open it in any browser.</p>' +
      '<div class="share-option" data-kind="short">' +
      '<div class="share-option-text">' +
      '<strong>Short link</strong>' +
      '<span>Compact for chat. Uses TinyURL under the hood (may not last forever).</span>' +
      '</div>' +
      '<button type="button" id="btn-share-short" class="btn-small">Copy short</button>' +
      '</div>' +
      '<div class="share-option" data-kind="long">' +
      '<div class="share-option-text">' +
      '<strong>Permanent link</strong>' +
      '<span>Longer URL with the full level baked in. Always works.</span>' +
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

  function ensureModal() {
    if (modalEl && document.body.contains(modalEl)) return modalEl;

    modalEl = document.getElementById('share-modal');
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = 'share-modal';
      modalEl.className = 'pp-modal hidden';
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('aria-labelledby', 'share-modal-title');
      modalEl.innerHTML = modalHtml();
      document.body.appendChild(modalEl);
    }

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
        if (e.key === 'Escape' && modalEl && !modalEl.classList.contains('hidden') && !busy) {
          closeShareMenu();
        }
      });
    }
    return modalEl;
  }

  function setBusy(on) {
    busy = !!on;
    if (shortBtn) shortBtn.disabled = !!on;
    if (longBtn) longBtn.disabled = !!on;
  }

  function clearOptionState() {
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
    clearOptionState();
    setBusy(false);
    setStatus('', '');
    setUrlPreview('');
    modalEl.classList.remove('hidden');
    // Prefer focusing the permanent option first? Short is fine as default.
    if (shortBtn) shortBtn.focus();
  }

  function closeShareMenu() {
    if (!modalEl) return;
    modalEl.classList.add('hidden');
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

  /**
   * ?lvl_short=alias → navigate to tinyurl.com/alias → 301 back with permanent ?lvl=
   * @returns {boolean} true if redirect started
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
    try {
      const splash = document.createElement('div');
      splash.id = 'lvl-short-resolving';
      splash.className = 'lvl-short-resolving';
      splash.textContent = 'Opening shared level…';
      document.body.appendChild(splash);
    } catch {
      /* ignore */
    }
    location.replace(S.tinyurlExpandUrl(alias));
    return true;
  }

  root.ShareLevel = {
    openShareMenu,
    closeShareMenu,
    createShortShareUrl,
    resolveLvlShortFromLocation,
    buildLongLevelUrl: (lvl) => S.buildLongLevelUrl(lvl, pageBaseHref()),
    buildShortLevelUrl: (alias) => S.buildShortLevelUrl(alias, pageBaseHref()),
  };
})(typeof self !== 'undefined' ? self : this);
