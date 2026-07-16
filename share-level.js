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
  let pendingLvl = null;
  let busy = false;

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
    if (navigator.clipboard && navigator.clipboard.writeText) {
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
    ta.select();
    try {
      if (!document.execCommand('copy')) throw new Error('copy failed');
    } finally {
      document.body.removeChild(ta);
    }
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.getElementById('share-level-menu');
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.id = 'share-level-menu';
      menuEl.className = 'hidden';
      menuEl.innerHTML =
        '<div class="share-level-card" role="dialog" aria-labelledby="share-level-title">' +
        '<h3 id="share-level-title">Share level</h3>' +
        '<p class="share-level-lead">Copy a link friends can open in the browser.</p>' +
        '<button type="button" id="btn-share-short" class="share-choice-btn">Short link</button>' +
        '<p class="share-choice-desc">Compact URL via TinyURL. Share as pocketputt.net/?lvl_short=…</p>' +
        '<button type="button" id="btn-share-long" class="share-choice-btn share-choice-secondary">Long link</button>' +
        '<p class="share-choice-desc">Permanent — full level data lives in the URL.</p>' +
        '<button type="button" id="btn-share-cancel" class="btn-quiet share-cancel-btn">Cancel</button>' +
        '<p id="share-level-status" class="share-level-status" aria-live="polite"></p>' +
        '</div>';
      document.body.appendChild(menuEl);
    }
    statusEl = document.getElementById('share-level-status');

    menuEl.addEventListener('click', (e) => {
      if (e.target === menuEl) closeShareMenu();
    });
    const btnShort = document.getElementById('btn-share-short');
    const btnLong = document.getElementById('btn-share-long');
    const btnCancel = document.getElementById('btn-share-cancel');
    if (btnShort) btnShort.addEventListener('click', () => void onChooseShort());
    if (btnLong) btnLong.addEventListener('click', () => void onChooseLong());
    if (btnCancel) btnCancel.addEventListener('click', closeShareMenu);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuEl && !menuEl.classList.contains('hidden')) {
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
    pendingLvl = lvl;
    busy = false;
    ensureMenu();
    setStatus('');
    menuEl.classList.remove('hidden');
    const shortBtn = document.getElementById('btn-share-short');
    if (shortBtn) shortBtn.focus();
  }

  function closeShareMenu() {
    if (!menuEl) return;
    menuEl.classList.add('hidden');
    pendingLvl = null;
    busy = false;
    setStatus('');
  }

  async function onChooseLong() {
    if (busy || !pendingLvl) return;
    busy = true;
    setStatus('Copying…');
    try {
      const url = S.buildLongLevelUrl(pendingLvl, pageBaseHref());
      await copyText(url);
      setStatus('Long link copied (' + url.length + ' chars)');
      setTimeout(closeShareMenu, 700);
    } catch (e) {
      setStatus('Copy failed: ' + (e && e.message ? e.message : e), true);
      busy = false;
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
    busy = true;
    setStatus('Creating short link…');
    const shortBtn = document.getElementById('btn-share-short');
    if (shortBtn) shortBtn.disabled = true;
    try {
      const url = await createShortShareUrl(pendingLvl);
      await copyText(url);
      setStatus('Short link copied');
      setTimeout(closeShareMenu, 700);
    } catch (e) {
      setStatus(
        'Short link failed: ' + (e && e.message ? e.message : e) + ' — try Long link instead.',
        true
      );
      busy = false;
    } finally {
      if (shortBtn) shortBtn.disabled = false;
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
