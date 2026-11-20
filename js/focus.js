'use strict';

/**
 * focus.js — TV Remote Focus Manager v4
 *
 * Thin adapter over js-spatial-navigation (luke-chang, MPL-2.0) — the
 * battle-tested vanilla-JS spatial navigation library used in production
 * Tizen / webOS / Hisense TV apps. It uses directional geometry scoring,
 * visibility checks and section memory instead of app-specific
 * nearest-neighbor logic.
 *
 * Why an adapter rather than a direct dependency:
 *   - Keeps the existing public API (Focus.select / handle / click / get /
 *     selectFirst / clearCache / reset) so app.js and player.js stay
 *     unchanged.
 *   - The library is initialized for its native focus/blur bookkeeping, while
 *     app.js captures keydown first and drives moves programmatically from our
 *     Tizen-aware key pipeline (keys.js -> app._key -> Focus.handle). That
 *     keeps Samsung-specific key codes (13636-13639) working without letting
 *     the library's desktop-arrow listener double-fire.
 *   - Mirror native :focus to the existing .sel CSS class so the visual
 *     styling keeps working unchanged.
 *   - Add container-aware scrolling on focus change. Tizen 5 (Chromium M63)
 *     scrollIntoView() is unreliable once nested scroll containers exist
 *     (catch-up has 2, EPG has 1, every category page has 2).
 *
 * Sections are registered once. Their selectors are dynamic
 * ([data-f="1"][data-zone="..."]) so re-renders never require
 * re-registration. makeFocusable() runs after each clearCache() to add
 * tabindex="-1" to newly-rendered focusables.
 *
 * Section config:
 *   restrict: 'self-first'   — try within section first, then spill out
 *   enterTo:  'last-focused' — re-entering a zone restores your spot
 *
 * That combination handles every flow on every page correctly:
 *   - axis=v zones (sidebar/cat/list): UP/DOWN find within-section
 *     candidates; LEFT/RIGHT have no in-section candidate (zones are
 *     vertical) so the W3C algorithm spills out to neighboring zones.
 *   - axis=h zones (pills/epg): LEFT/RIGHT find within-section candidates;
 *     UP/DOWN have no in-section candidate so they spill out.
 *   - axis=both zones (grid/main): all directions try within first, spill
 *     at edges. Grids follow the library's geometry scoring.
 */

(function () {
  if (typeof SpatialNavigation === 'undefined') {
    console.error('[Focus] SpatialNavigation library missing — load js/spatial_navigation.js before js/focus.js');
    /* No-op stub so app.js / player.js calls don't throw. */
    var noop = function () {};
    window.Focus = {
      select: noop, get: function () { return null; }, click: noop,
      handle: noop, move: noop, selectFirst: noop, clearCache: noop, refreshSoon: noop, reset: noop,
    };
    return;
  }

  var ZONES = ['sidebar', 'cat', 'list', 'grid', 'pills', 'main', 'epg', 'controls',
               'cu-channels', 'cu-days', 'cu-programs', 'player-panel'];
  var SECTION_CFG = {
    restrict: 'self-first',
    enterTo: 'last-focused',
    straightOverlapThreshold: 0.3,
  };

  var _ready = false;
  var _lastZone = null;      /* zone of the most recently focused element */
  var _lastMove = 0;         /* timestamp of last processed arrow key */
  var MOVE_THROTTLE = 70;    /* ms — caps held-key repeat without feeling laggy */
  var _refreshTimer = null;
  var _zoneElements = {};

  function playerLocked() {
    /* NOTE: Player is a top-level const — it lives in the global lexical
       scope, NOT on window. Reference it directly inside try/typeof. */
    try { return typeof Player !== 'undefined' && Player.isActive(); }
    catch (_) { return false; }
  }

  function inOverlay(el) {
    while (el) {
      if (el.id === 'player-overlay') return true;
      el = el.parentElement;
    }
    return false;
  }

  function addSection(z) {
    var cfg = {};
    for (var k in SECTION_CFG) cfg[k] = SECTION_CFG[k];
    cfg.selector = '[data-f="1"][data-zone="' + z + '"]';
    /* Entering a zone (selectFirst / restore) prefers non-input elements so
       the Tizen IME never pops open uninvited. Inputs stay reachable by
       deliberately navigating onto them. */
    cfg.defaultElement = '[data-f="1"][data-zone="' + z + '"]:not(input):not(textarea)';
    try { SpatialNavigation.add(z, cfg); } catch (_) { /* already exists */ }
  }

  function setup() {
    if (_ready) return;
    _ready = true;

    try { SpatialNavigation.init(); } catch (_) {}
    /* CRITICAL: pause the library's own window-level keydown listener.
       app.js owns the key pipeline (keys.js -> App._key -> Focus.handle ->
       SpatialNavigation.move). init() also installs the library's onKeyDown
       on window; preventDefault() in App._key does NOT stop it, so without
       pause() every arrow press is processed twice and focus moves two
       steps (and can spill into the next section). While paused, move()
       and focus() still work via the silent path, and lastFocusedElement
       bookkeeping (enterTo:'last-focused') stays intact. */
    try { SpatialNavigation.pause(); } catch (_) {}
    ZONES.forEach(addSection);

    /* While the player is fullscreen, the page behind it still has laid-out
       elements. Without this filter the spatial algorithm happily moves
       focus to invisible items behind the video. */
    try {
      SpatialNavigation.set({
        navigableFilter: function (elem) {
          if (playerLocked()) return inOverlay(elem);
          return true;
        },
      });
    } catch (_) {}

    try { SpatialNavigation.makeFocusable(); } catch (_) {}

    /* Secondary mirror for focus changes we didn't initiate (pointer on TV).
       Primary .sel sync is syncSel(), called explicitly after every
       programmatic move — focus events are unreliable in throttled or
       unfocused windows, so the visual state must not depend on them. */
    document.addEventListener('focusin', syncSel, true);
    document.addEventListener('focusout', function () { setTimeout(syncSel, 0); }, true);
  }

  /* Make the .sel class follow document.activeElement. */
  var _selEl = null;
  function syncSel() {
    var a = document.activeElement;
    var t = (a && a !== document.body && a.dataset && a.dataset.f === '1') ? a : null;
    if (_selEl === t) return;
    if (_selEl) { try { _selEl.classList.remove('sel'); } catch (_) {} }
    _selEl = t;
    if (t) {
      t.classList.add('sel');
      if (t.dataset.zone) {
        _lastZone = t.dataset.zone;
        if(t.tagName!=='INPUT' && t.tagName!=='TEXTAREA') _zoneElements[_lastZone]=t;
      }
      scrollIntoViewSafe(t);
    }
  }

  /* Walk every scrollable ancestor and adjust scrollTop / scrollLeft so
     the focused element ends up comfortably inside that container. Then
     nudge the window if the element still overflows the viewport.
     scrollIntoView() is buggy on Tizen 5; doing it explicitly is safer. */
  function scrollIntoViewSafe(el) {
    try {
      var PAD = 28;
      var p = el.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        var canY = p.scrollHeight > p.clientHeight + 4;
        var canX = p.scrollWidth > p.clientWidth + 4;
        if (canY || canX) {
          var r = el.getBoundingClientRect();
          var pr = p.getBoundingClientRect();
          if (canY) {
            if (r.top < pr.top + PAD)            p.scrollTop -= (pr.top + PAD - r.top);
            else if (r.bottom > pr.bottom - PAD) p.scrollTop += (r.bottom - pr.bottom + PAD);
          }
          if (canX) {
            if (r.left < pr.left + PAD)          p.scrollLeft -= (pr.left + PAD - r.left);
            else if (r.right > pr.right - PAD)   p.scrollLeft += (r.right - pr.right + PAD);
          }
        }
        p = p.parentElement;
      }
      var rr = el.getBoundingClientRect();
      var vpH = window.innerHeight || 1080;
      var vpW = window.innerWidth || 1920;
      if (rr.top < PAD)                window.scrollBy(0, rr.top - PAD);
      else if (rr.bottom > vpH - PAD)  window.scrollBy(0, rr.bottom - vpH + PAD);
      if (rr.left < PAD)               window.scrollBy(rr.left - PAD, 0);
      else if (rr.right > vpW - PAD)   window.scrollBy(rr.right - vpW + PAD, 0);
    } catch (_) {}
  }

  function isFocusable(el) {
    return el && el.dataset && el.dataset.f === '1';
  }

  function activeFocus() {
    var a = document.activeElement;
    return (a && a !== document.body && isFocusable(a)) ? a : null;
  }

  function visible(el) {
    if(!el || !document.documentElement.contains(el)) return false;
    var r=el.getBoundingClientRect();
    return r.width>0 && r.height>0;
  }
  function firstVisible(root,selector) {
    if(!root) return null;
    var nodes=root.querySelectorAll(selector);
    for(var i=0;i<nodes.length;i++) if(visible(nodes[i])) return nodes[i];
    return null;
  }
  function categoryTarget() {
    return firstVisible(document,'.cat-item.active') || firstVisible(document,'.cat-item');
  }
  function contentTarget(root) {
    root=root || document.querySelector('.content-panel') || document.getElementById('main');
    if(!root) return null;
    var zones=['grid','list','main','pills','cu-channels','epg'];
    for(var i=0;i<zones.length;i++) {
      var remembered=_zoneElements[zones[i]];
      if(visible(remembered) && root.contains(remembered)) return remembered;
    }
    return firstVisible(root,'[data-f="1"][data-zone="grid"], [data-f="1"][data-zone="list"]') ||
      firstVisible(root,'[data-f="1"]:not(input):not(textarea)') ||
      firstVisible(root,'[data-f="1"]');
  }
  function hasLeftCard(current) {
    var grid=current.closest('.vod-grid, .card-row');
    if(!grid) return false;
    var r=current.getBoundingClientRect();
    var cards=grid.querySelectorAll('[data-f="1"]');
    for(var i=0;i<cards.length;i++) {
      if(cards[i]===current || !visible(cards[i])) continue;
      var c=cards[i].getBoundingClientRect();
      if(c.left<r.left-4 && Math.min(c.bottom,r.bottom)-Math.max(c.top,r.top)>Math.min(c.height,r.height)*0.5) return true;
    }
    return false;
  }
  /* Panel changes have a clear destination independent of row alignment.
     Geometry still handles movement within a grid or list. */
  function moveBetweenPanels(current,dir) {
    if(playerLocked()) return false;
    var zone=current.dataset.zone;
    var target=null;
    if(zone==='sidebar' && dir==='right') target=categoryTarget() || contentTarget();
    else if(zone==='cat' && dir==='left') target=firstVisible(document,'#sidenav .nav-item.active') || firstVisible(document,'#sidenav .nav-item');
    else if(zone==='cat' && dir==='right') {
      if(current.classList.contains('cat-item')) { current.click(); return true; }
      target=contentTarget();
    } else if(current.closest('.content-panel')) {
      if(dir==='left' && (zone!=='grid' || !hasLeftCard(current))) target=categoryTarget();
      if(dir==='up' && zone==='list') {
        var previous=SpatialNavigation.findNext && SpatialNavigation.findNext('up','[data-f="1"][data-zone="list"]',current);
        if(!previous) target=firstVisible(current.closest('.content-panel'),'input[data-f="1"]');
      }
    }
    if(!target) return false;
    window.Focus.select(target);
    return true;
  }

  /* ─────────── Public API (drop-in compatible with v1/v2/v3) ─────────── */

  window.Focus = {
    /* Programmatic focus on a specific element. */
    select: function (el) {
      setup();
      if (!el) return;
      try { SpatialNavigation.makeFocusable(); } catch (_) {}
      try { SpatialNavigation.focus(el); }
      catch (_) {
        /* Fallback for elements not in any registered section
           (e.g., player overlay buttons). Just call native focus(). */
        try { el.focus(); } catch (__) {}
      }
      syncSel();
    },

    get: function () { return activeFocus(); },

    enterContent: function () {
      var target=contentTarget();
      if(target) this.select(target);
    },

    /* ENTER key: click for buttons/cards; for inputs, blur+focus to make
       the soft-keyboard re-open (no-op .focus() on already-focused element
       won't trigger the Tizen IME). */
    click: function () {
      var el = activeFocus();
      if (!el) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        try { el.blur(); el.focus(); } catch (_) {}
        syncSel();
        return;
      }
      el.click();
    },

    /* Arrow-key handler (called from app._key). */
    handle: function (dir) {
      setup();
      var d = (dir || '').toLowerCase();
      if (d !== 'left' && d !== 'right' && d !== 'up' && d !== 'down') return;

      /* Throttle held-key auto-repeat: each move costs a full spatial scan
         (hundreds of getBoundingClientRect on long lists), and TV remotes
         repeat at ~30Hz. 70ms keeps scrolling fluid without queueing jank. */
      var now = Date.now();
      if (now - _lastMove < MOVE_THROTTLE) return;
      _lastMove = now;

      if (!activeFocus()) {
        /* Lost focus (e.g., post-render activeElement = body, or the
           focused element was removed). Restore into the zone the user
           was last in — falling back to the library's default chain. */
        this.restore();
        return;
      }
      try {
        var current = activeFocus();
        if(moveBetweenPanels(current,d)) return;
        var axis = (current && current.getAttribute('data-axis')) || 'both';
        var zone = current && current.getAttribute('data-zone');
        var epgRow = current && current.getAttribute('data-epg-row');
        if (epgRow && (d === 'left' || d === 'right') && SpatialNavigation.findNext) {
          var epgNext = SpatialNavigation.findNext(
            d,
            '[data-f="1"][data-epg-row="' + epgRow + '"]',
            current
          );
          if (epgNext) SpatialNavigation.focus(epgNext);
          syncSel(); return;
        }
        var primary = (axis === 'v' && (d === 'up' || d === 'down')) ||
                      (axis === 'h' && (d === 'left' || d === 'right'));
        if ((axis === 'v' || axis === 'h') && zone && SpatialNavigation.findNext) {
          var selector = primary ?
            '[data-f="1"][data-zone="' + zone + '"]' :
            '[data-f="1"]:not([data-zone="' + zone + '"])';
          var next = SpatialNavigation.findNext(d, selector, current);
          if (next) SpatialNavigation.focus(next);
          else if(primary && zone!=='sidebar' && zone!=='cat') SpatialNavigation.move(d);
        } else {
          SpatialNavigation.move(d);
        }
      } catch (_) {}
      syncSel();
    },

    /* Re-establish focus after it was lost (re-render, player close).
       Prefers the zone the user was last in; '@zone' uses the section's
       enterTo:'last-focused' so the exact element is restored when it
       still exists, or its section's first item when it doesn't. */
    restore: function () {
      setup();
      try { SpatialNavigation.makeFocusable(); } catch (_) {}
      try {
        if (_lastZone && SpatialNavigation.focus('@' + _lastZone)) { syncSel(); return; }
        var chain = ['list', 'grid', 'cat', 'main', 'pills', 'sidebar', 'controls'];
        for (var i = 0; i < chain.length; i++) {
          if (chain[i] === _lastZone) continue;
          if (SpatialNavigation.focus('@' + chain[i])) { syncSel(); return; }
        }
        SpatialNavigation.focus();
      } catch (_) {}
      syncSel();
    },

    move: function (dir) { this.handle(dir); },

    /* Place focus on first/remembered element of the given zone. */
    selectFirst: function (zone) {
      setup();
      try { SpatialNavigation.makeFocusable(); } catch (_) {}
      var ok = false;
      try { ok = !!SpatialNavigation.focus('@' + zone); } catch (_) {}
      if (!ok) {
        var fallback = ['cat', 'grid', 'list', 'main', 'pills', 'sidebar'];
        for (var i = 0; i < fallback.length; i++) {
          if (fallback[i] === zone) continue;
          try { if (SpatialNavigation.focus('@' + fallback[i])) break; } catch (_) {}
        }
      }
      syncSel();
    },

    /* In-page DOM mutation hook. Re-tag any newly-rendered focusables
       with tabindex. Keep section memory intact so search-filter and
       category-switch don't lose the user's spot. */
    clearCache: function () {
      setup();
      try { SpatialNavigation.makeFocusable(); } catch (_) {}
    },

    /* Coalesce asynchronous EPG/list insertions into one tabindex refresh. */
    refreshSoon: function () {
      setup();
      clearTimeout(_refreshTimer);
      _refreshTimer = setTimeout(function () {
        try { SpatialNavigation.makeFocusable(); } catch (_) {}
      }, 25);
    },
    /* Page-level reset (called by App.go). Drops every section's
       lastFocusedElement so re-entering a zone on the new page doesn't
       try to restore a stale or wrong-page element. */
    reset: function () {
      setup();
      _lastZone = null;
      _zoneElements = {};
      var cur = activeFocus();
      if (cur) {
        try { cur.blur(); } catch (_) {}
      }
      /* The library has no public API to clear lastFocusedElement, so
         we remove + re-add each section. Cheap — there are only 7. */
      ZONES.forEach(function (z) {
        try { SpatialNavigation.remove(z); } catch (_) {}
      });
      ZONES.forEach(addSection);
      try { SpatialNavigation.makeFocusable(); } catch (_) {}
      syncSel();
    },
  };
})();
