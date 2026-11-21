// Safeguard Cleaning — quote form. Two steps: required contact details, then optional details.
// Sends to /api/quote (functions/api/quote.js). Spam check: Cloudflare Turnstile + hidden trap field.
(function () {
  'use strict';

  var step1 = document.getElementById('step-1');
  var step2 = document.getElementById('step-2');
  var done = document.getElementById('done');
  if (!step1) return;

  var leadToken = null;
  var widgetId = null;
  var turnstileReady = false;
  var FALLBACK = ' You can also email us at safeguardcleaningco@gmail.com.';

  // ----- Spam check (Turnstile) -----
  window.sgTurnstileReady = function () {
    turnstileReady = true;
    renderTurnstile();
  };
  var siteKey = null;
  fetch('/api/config', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (cfg) {
      siteKey = cfg && cfg.turnstileSiteKey;
      if (!siteKey) return;
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=sgTurnstileReady';
      s.async = true; s.defer = true;
      document.head.appendChild(s);
    })
    .catch(function () { /* handled on submit */ });

  function renderTurnstile() {
    if (!turnstileReady || !siteKey || widgetId !== null || !window.turnstile) return;
    widgetId = window.turnstile.render('#turnstile', { sitekey: siteKey, theme: 'light', action: 'quote' });
  }
  function turnstileToken() {
    return (window.turnstile && widgetId !== null) ? window.turnstile.getResponse(widgetId) : '';
  }
  function resetTurnstile() {
    if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
  }

  // ----- Validation (mirrors the server rules) -----
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function setError(id, msg) {
    var input = document.getElementById(id);
    var err = document.getElementById(id + '-err');
    if (err) err.textContent = msg || '';
    if (input) {
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  }
  function validateStep1() {
    var errors = {};
    if (!val('name')) errors.name = 'Please enter your name.';
    if (!val('businessName')) errors.businessName = 'Please enter your business name.';
    if (!EMAIL_RE.test(val('email'))) errors.email = 'Please enter a valid email address.';
    if (val('phone').replace(/\D/g, '').length < 10) errors.phone = 'Please enter a phone number we can reach you at.';
    if (!val('city')) errors.city = 'Please enter your city.';
    return errors;
  }
  function showErrors(errors) {
    ['name', 'businessName', 'email', 'phone', 'city'].forEach(function (f) { setError(f, errors[f]); });
    var firstBad = ['name', 'businessName', 'email', 'phone', 'city'].filter(function (f) { return errors[f]; })[0];
    if (firstBad) document.getElementById(firstBad).focus();
  }

  function source() {
    try { return JSON.parse(sessionStorage.getItem('sg_source') || '{}'); } catch (e) { return {}; }
  }

  function busy(form, on, label) {
    var btn = form.querySelector('[data-submit]');
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  function post(body) {
    return fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    });
  }

  // ----- Step 1 submit -----
  var alert1 = document.getElementById('step1-alert');
  step1.addEventListener('submit', function (e) {
    e.preventDefault();
    alert1.textContent = '';
    var errors = validateStep1();
    showErrors(errors);
    if (Object.keys(errors).length) return;

    if (!siteKey) { alert1.textContent = 'Sorry, the form is not available right now.' + FALLBACK; return; }
    var token = turnstileToken();
    if (!token) { alert1.textContent = 'Please wait a moment for the spam check to finish, then try again.'; return; }

    busy(step1, true, 'Sending…');
    post({
      step: 1,
      name: val('name'),
      businessName: val('businessName'),
      email: val('email'),
      phone: val('phone'),
      city: val('city'),
      website: document.getElementById('website').value,
      turnstileToken: token,
      source: source()
    }).then(function (r) {
      busy(step1, false);
      if (r.status === 200 && r.data.ok) {
        leadToken = r.data.token || null;
        var first = val('name').split(/\s+/)[0];
        document.querySelector('[data-first-name]').textContent = first ? ', ' + first : '';
        step1.hidden = true;
        step2.hidden = false;
        document.getElementById('form-h2').focus();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      resetTurnstile();
      if (r.status === 400 && r.data.errors) { showErrors(r.data.errors); if (r.data.errors.turnstile) alert1.textContent = r.data.errors.turnstile; return; }
      if (r.status === 429) { alert1.textContent = 'We\'ve received several requests from you already. Please try again later.' + FALLBACK; return; }
      alert1.textContent = 'Sorry, something went wrong sending your request.' + FALLBACK;
    }).catch(function () {
      busy(step1, false);
      resetTurnstile();
      alert1.textContent = 'We couldn\'t reach our server. Please check your connection and try again.' + FALLBACK;
    });
  });

  // ----- Step 2 submit / skip -----
  var alert2 = document.getElementById('step2-alert');
  function finish() {
    step2.hidden = true;
    done.hidden = false;
    document.getElementById('form-h3').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  step2.addEventListener('submit', function (e) {
    e.preventDefault();
    alert2.textContent = '';
    var details = {
      facilityType: val('facilityType'), sizeRange: val('sizeRange'), restrooms: val('restrooms'),
      frequency: val('frequency'), startDate: val('startDate'), heardAbout: val('heardAbout'), notes: val('notes')
    };
    var anything = Object.keys(details).some(function (k) { return details[k]; });
    if (!anything || !leadToken) { finish(); return; }
    busy(step2, true, 'Sending…');
    post({ step: 2, token: leadToken, details: details }).then(function (r) {
      busy(step2, false);
      if (r.status === 200 && r.data.ok) { finish(); return; }
      alert2.textContent = 'Sorry, we couldn\'t save those details. Your request is already in, so you can skip this step.';
    }).catch(function () {
      busy(step2, false);
      alert2.textContent = 'We couldn\'t reach our server. Your request is already in, so you can skip this step.';
    });
  });
  step2.querySelector('[data-skip]').addEventListener('click', finish);
})();
