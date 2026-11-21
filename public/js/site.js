// Safeguard Cleaning — shared page behaviour: footer year and lead-source tracking.
// The menu, hover and motion come from the design kit in /assets (system.js, motion.js).
(function () {
  'use strict';

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
