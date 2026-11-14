// Safeguard Cleaning — shared page behaviour: mobile menu, footer year, lead-source tracking.
(function () {
  'use strict';

  // ----- Mobile menu -----
  var menu = document.getElementById('mobile-menu');
  var openBtn = document.querySelector('[data-menu-open]');
  var lastFocus = null;

  function openMenu() {
    if (!menu) return;
    lastFocus = document.activeElement;
    menu.hidden = false;
    document.body.classList.add('menu-open');
    if (openBtn) openBtn.setAttribute('aria-expanded', 'true');
    var first = menu.querySelector('a, button');
    if (first) first.focus();
  }

  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    document.body.classList.remove('menu-open');
    if (openBtn) openBtn.setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  if (openBtn) openBtn.addEventListener('click', openMenu);
  document.querySelectorAll('[data-menu-close]').forEach(function (el) {
    el.addEventListener('click', closeMenu);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
    // Keep keyboard focus inside the open menu.
    if (e.key === 'Tab' && menu && !menu.hidden) {
      var items = menu.querySelectorAll('a, button');
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('resize', function () { if (window.innerWidth > 1000) closeMenu(); });

  // ----- Footer year -----
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });

  // ----- Lead source: remember where the visitor first came from (sent with the quote form) -----
  try {
    if (!sessionStorage.getItem('sg_source')) {
      var params = new URLSearchParams(window.location.search);
      sessionStorage.setItem('sg_source', JSON.stringify({
        landingPage: window.location.pathname,
        referrer: document.referrer || '',
        utmSource: params.get('utm_source') || '',
        utmMedium: params.get('utm_medium') || '',
        utmCampaign: params.get('utm_campaign') || ''
      }));
    }
  } catch (err) { /* storage blocked: tracking is optional */ }
})();
