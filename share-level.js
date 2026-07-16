// Pocket Putt — custom level share UI (short via TinyURL / long permanent).
// Depends on window.Shared. Loaded by index.html + editor.html as a classic script.
(function (root) {
  'use strict';

  const S = root.Shared;
  if (!S) {
    console.error('share-level.js requires shared.js first');
    return;
  }

  const CACHE_PREFIX = 'pp_lvl_short_';
  let menuEl = null;
  let statusEl = null;
  let urlPreviewEl = null;
  let pendingLvl = null;
  let busy = false;
  let closeTimer = null;

  function cacheKey(lvl) {
    // Stable short key without storing the whole base64 blob as the storage key.
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
      /* quota / private mode */
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
    // Fallback for older / non-secure contexts
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

  function setBusy(on) {
    busy = !!on;
    const shortBtn = document.getElementById('btn-share-short');
    const longBtn = document.getElementById('btn-share-long');
    if (shortBtn) shortBtn.disabled = !!on;
    if (longBtn) longBtn.disabled = !!on;
  }

  function resetChoiceButtons() {
    const shortBtn = document.getElementById('btn-share-short');
    const longBtn = document.getElementById('btn-share-long');
    if (shortBtn) {
      shortBtn.disabled = false;
      shortBtn.classList.remove('is-copied');
      shortBtn.querySelector('.share-choice-title').textContent = 'Copy short link';
    }
    if (longBtn) {
      longBtn.disabled = false;
      longBtn.classList.remove('is-copied');
      longBtn.querySelector('.share-choice-title').textContent = 'Copy permanent link';
    }
  }

  function setStatus(msg, kind) {
    // kind: '' | 'ok' | 'error' | 'pending'
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.remove('is-error', 'is-ok', 'is-pending');
    if (kind === 'error') statusEl.classList.add('is-error');
    else if (kind === 'ok') statusEl.classList.add('is-ok');
    else if (kind === 'pending') statusEl.classList.add('is-pending');
  }

  function setUrlPreview(url) {
    if (!urlPreviewEl) return;
    if (!url) {
      urlPreviewEl.classList.add('hidden');
      urlPreviewEl.value = '';
      return;
    }
    urlPreviewEl.value = url;
    urlPreviewEl.classList.remove('hidden');
    // Select so user can Cmd+C again if clipboard failed silently.
    try {
      urlPreviewEl.focus();
      urlPreviewEl.select();
    } catch {
      /* ignore */
    }
  }

  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.getElementById('share-level-menu');
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.id = 'share-level-menu';
      menuEl.className = 'hidden';
      menuEl.innerHTML =
        '<div class="share-level-card" role="dialog" aria-modal="true" aria-labelledby="share-level-title">' +
        '<h3 id="share-level-title">Share this level</h3>' +
        '<p class="share-level-lead">Pick a link type, then we copy it to your clipboard.</p>' +
        '<div class="share-choice-list">' +
        '<button type="button" id="btn-share-short" class="share-choice-btn">' +
        '<span class="share-choice-title">Copy short link</span>' +
        '<span class="share-choice-desc">Compact — easy to text or paste in chat. Uses TinyURL under the hood (may not last forever).</span>' +
        '</button>' +
        '<button type="button" id="btn-share-long" class="share-choice-btn share-choice-secondary">' +
        '<span class="share-choice-title">Copy permanent link</span>' +
        '<span class="share-choice-desc">Longer URL with the full level baked in. Always works; never depends on TinyURL.</span>' +
        '</button>' +
        '</div>' +
        '<p id="share-level-status" class="share-level-status" aria-live="assertive"></p>' +
        '<label class="share-url-label hidden" id="share-url-label" for="share-level-url">Link on clipboard</label>' +
        '<input type="text" id="share-level-url" class="share-level-url hidden" readonly aria-label="Copied share link">' +
        '<button type="button" id="btn-share-cancel" class="btn-quiet share-cancel-btn">Close</button>' +
        '</div>';
      document.body.appendChild(menuEl);
    }
    statusEl = document.getElementById('share-level-status');
    urlPreviewEl = document.getElementById('share-level-url');

    menuEl.addEventListener('click', (e) => {
      if (e.target === menuEl && !busy) closeShareMenu();
    });
    const btnShort = document.getElementById('btn-share-short');
    const btnLong = document.getElementById('btn-share-long');
    const btnCancel = document.getElementById('btn-share-cancel');
    if (btnShort) btnShort.addEventListener('click', () => void onChooseShort());
    if (btnLong) btnLong.addEventListener('click', () => void onChooseLong());
    if (btnCancel) btnCancel.addEventListener('click', closeShareMenu);
    if (urlPreviewEl) {
      urlPreviewEl.addEventListener('click', () => {
        try { urlPreviewEl.select(); } catch { /* ignore */ }
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuEl && !menuEl.classList.contains('hidden') && !busy) {
        closeShareMenu();
      }
    });
    return menuEl;
  }

  function openShareMenu(lvl) {
    if (typeof lvl !== 'string' || !lvl) {
      console.warn('openShareMenu: missing lvl');
      return;
    }
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    pendingLvl = lvl;
    busy = false;
    ensureMenu();
    resetChoiceButtons();
    setStatus('Tap a button above to copy a link.', '');
    setUrlPreview('');
    const urlLabel = document.getElementById('share-url-label');
    if (urlLabel) urlLabel.classList.add('hidden');
    menuEl.classList.remove('hidden');
    const shortBtn = document.getElementById('btn-share-short');
    if (shortBtn) shortBtn.focus();
  }

  function closeShareMenu() {
    if (!menuEl) return;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    menuEl.classList.add('hidden');
    pendingLvl = null;
    busy = false;
    setStatus('');
    setUrlPreview('');
    resetChoiceButtons();
  }

  function markCopied(which, url) {
    const btn = document.getElementById(which === 'short' ? 'btn-share-short' : 'btn-share-long');
    if (btn) {
      btn.classList.add('is-copied');
      const title = btn.querySelector('.share-choice-title');
      if (title) title.textContent = '✓ Copied!';
    }
    setUrlPreview(url);
    const urlLabel = document.getElementById('share-url-label');
    if (urlLabel) {
      urlLabel.classList.remove('hidden');
      urlLabel.textContent = 'Copied — paste anywhere (or select below to re-copy)';
    }
    setStatus(
      which === 'short'
        ? 'Short link copied to clipboard.'
        : 'Permanent link copied to clipboard.',
      'ok'
    );
    // Keep the success state on screen long enough to read; do not vanish instantly.
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = null;
      // Leave dialog open — user closes when ready. Just clear busy.
      setBusy(false);
    }, 400);
  }

  async function onChooseLong() {
    if (busy || !pendingLvl) return;
    setBusy(true);
    setStatus('Copying permanent link…', 'pending');
    setUrlPreview('');
    try {
      const url = S.buildLongLevelUrl(pendingLvl, pageBaseHref());
      await copyText(url);
      markCopied('long', url);
    } catch (e) {
      setStatus(
        'Could not copy. Select the link below and press ⌘C / Ctrl+C.',
        'error'
      );
      try {
        const url = S.buildLongLevelUrl(pendingLvl, pageBaseHref());
        setUrlPreview(url);
        const urlLabel = document.getElementById('share-url-label');
        if (urlLabel) {
          urlLabel.classList.remove('hidden');
          urlLabel.textContent = 'Copy this permanent link manually';
        }
      } catch { /* ignore */ }
      setBusy(false);
    }
  }

  /**
   * Create a TinyURL for the permanent long link, then share pocketputt/?lvl_short=alias.
   * TinyURL is the shortlink database; pocketputt resolves by redirecting to tinyurl.com/alias.
   */
  async function createShortShareUrl(lvl) {
    const cached = readCachedAlias(lvl);
    if (cached) {
      return S.buildShortLevelUrl(cached, pageBaseHref());
    }
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
    setStatus('Creating short link via TinyURL…', 'pending');
    setUrlPreview('');
    try {
      const url = await createShortShareUrl(pendingLvl);
      await copyText(url);
      markCopied('short', url);
    } catch (e) {
      const detail = e && e.message ? e.message : String(e);
      setStatus(
        'Short link failed (' + detail + '). Try “Copy permanent link” instead.',
        'error'
      );
      setBusy(false);
    }
  }

  /**
   * If the page was opened with ?lvl_short=alias, bounce through TinyURL so the
   * browser follows their 301 back to pocketputt with ?lvl=… (permanent payload).
   * @returns {boolean} true if a redirect was initiated (caller should stop init)
   */
  function resolveLvlShortFromLocation(searchParams) {
    const params = searchParams || new URLSearchParams(location.search);
    // Prefer full payload if both are present.
    if ((params.get(S.LVL_PARAM) || '').trim()) return false;
    const alias = (params.get(S.LVL_SHORT_PARAM) || '').trim();
    if (!alias) return false;
    if (!S.isValidTinyAlias(alias)) {
      console.warn('Invalid lvl_short alias');
      return false;
    }
    // Soft splash so the redirect does not look like a hang.
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
