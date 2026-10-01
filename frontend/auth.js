// Training Wire — Auth gate
//
// THE NORMAL PATH IS ONE SCREEN: email + MPIN. The master code is a one-time
// registration gate, not a per-session password, so it appears exactly twice
// in an account's life — when registering, and again only if the MPIN has
// been forgotten.
//
//   sign in     email + MPIN                        -> mpin-login
//   register    email + username -> code -> MPIN    -> code-verify, mpin-set
//   forgot      email -> code -> new MPIN           -> code-verify, mpin-reset
//
// The username is captured once at registration and stored server-side; it is
// the author name on every snap, and it comes back on the session rather than
// being retyped or trusted from the client.
//
// EVERY DECISION HERE IS THE SERVER'S. This file validates shapes so a typo
// gets instant feedback, but it never decides whether a code or an MPIN is
// correct — the endpoints do, against a PBKDF2 hash the browser cannot reach.
// An earlier build checked both in the browser, which meant anyone who opened
// devtools could walk straight in.
console.log('Training Wire: Auth gate loaded');

const Auth = (() => {
  'use strict';

  const TR_DOMAIN = 'thomsonreuters.com';
  const IDENT_KEY = 'tw_ident';          // remembered email + username, convenience only

  const $ = (id) => document.getElementById(id);
  const val = (id) => ($(id)?.value || '').trim();

  let email = '';
  let username = '';
  let gatePurpose = 'register';          // 'register' | 'reset' — why we are at the code step
  let signedIn = false;
  let busy = false;
  let onSignedIn = null;

  // ── validation (shape only — the server decides everything that matters) ──
  const EMAIL_RE = new RegExp('^[A-Za-z0-9._%+-]+@' + TR_DOMAIN.replace('.', '\\.') + '$', 'i');
  const USER_RE = /^[A-Za-z][A-Za-z .'\-]{1,23}$/;      // must match code-verify.js
  const MPIN_RE = /^\d{6}$/;
  const CODE_RE = /^\d{6}$/;

  function emailError(e) {
    if (!e) return 'Enter your Thomson Reuters email address.';
    if (!e.includes('@')) return 'That is missing the @ — it should look like first.last@' + TR_DOMAIN;
    if (!EMAIL_RE.test(e)) return 'Use your @' + TR_DOMAIN + ' address. Other domains cannot register.';
    return '';
  }
  function usernameError(n) {
    if (!n) return 'Enter a username — this becomes your author name on every snap.';
    if (!USER_RE.test(n)) return 'Username must start with a letter and be 2–24 letters, spaces, dots, hyphens or apostrophes.';
    return '';
  }

  // ── screens ───────────────────────────────────────────────────────────────
  const STEPS = ['authSignin', 'authRegister', 'authCode', 'authMpin'];
  const SUBS = {
    authSignin: 'Sign in with your Thomson Reuters email and MPIN',
    authRegister: 'First time here — register your email',
    authCode: 'Enter the master code you were given',
    authMpin: 'Choose a 6-digit MPIN'
  };

  function show(step) {
    STEPS.forEach(id => $(id)?.classList.toggle('on', id === step));
    const sub = $('authSub'); if (sub) sub.textContent = SUBS[step] || '';
    clearErrors();
    const first = $(step)?.querySelector('.auth-in:not([disabled])');
    if (first) setTimeout(() => first.focus(), 50);
  }

  function clearErrors() {
    ['authSigninErr', 'authRegErr', 'authCodeErr', 'authMpinErr'].forEach(id => { const e = $(id); if (e) e.textContent = ''; });
  }
  function err(id, msg) { const e = $(id); if (e) e.textContent = msg || ''; }

  function setBusy(b) {
    busy = b;
    const gate = $('authGate');
    if (gate) {
      gate.classList.toggle('busy', b);
      gate.querySelectorAll('button').forEach(el => { el.disabled = b; });
    }
  }

  function showSigninStep() {
    show('authSignin');
    const e = $('authEmailIn'); if (e) e.value = email;
    const p = $('authPinIn'); if (p) p.value = '';
    if (email) setTimeout(() => $('authPinIn')?.focus(), 60);   // email remembered: straight to the PIN
  }

  function showCodeStep(purpose) {
    gatePurpose = purpose;
    show('authCode');
    const note = $('authCodeNote');
    if (note) {
      note.textContent = purpose === 'reset'
        ? 'Enter the master code to set a new MPIN for ' + email + '.'
        : 'Enter the master code you were given with your training. This is only needed once.';
    }
    const c = $('authCodeIn'); if (c) c.value = '';
  }

  function showMpinStep() {
    show('authMpin');
    const note = $('authMpinNote');
    if (note) {
      note.textContent = gatePurpose === 'reset'
        ? 'Choose a new 6-digit MPIN. This replaces your old one.'
        : 'Choose a 6-digit MPIN. From now on you sign in with just your email and this MPIN.';
    }
    const btn = $('authMpinGo');
    if (btn) btn.textContent = gatePurpose === 'reset' ? 'Reset MPIN' : 'Set MPIN';
    ['authMpin1', 'authMpin2'].forEach(id => { const e = $(id); if (e) e.value = ''; });
  }

  // ── actions ───────────────────────────────────────────────────────────────
  // The normal path: email + MPIN straight to a session.
  async function doSignin() {
    if (busy) return;
    const e = val('authEmailIn').toLowerCase();
    const pin = val('authPinIn');
    clearErrors();
    const ee = emailError(e); if (ee) { err('authSigninErr', ee); $('authEmailIn')?.focus(); return; }
    if (!MPIN_RE.test(pin)) { err('authSigninErr', 'Enter your 6-digit MPIN.'); $('authPinIn')?.focus(); return; }

    setBusy(true);
    try {
      const res = await WireClient.loginMpin(e, pin);
      email = e;
      if (res && res.name) username = res.name;
      rememberIdentity();
      enter();
    } catch (e2) {
      err('authSigninErr', e2.message || 'That email and MPIN do not match.');
      const p = $('authPinIn'); if (p) { p.value = ''; p.focus(); }
    } finally {
      setBusy(false);
    }
  }

  // Registration, step one. No network call — nothing to send until the code.
  function doRegisterIdentify() {
    if (busy) return;
    const e = val('authEmail').toLowerCase();
    const n = val('authUser');
    clearErrors();
    const ee = emailError(e); if (ee) { err('authRegErr', ee); $('authEmail')?.focus(); return; }
    const ue = usernameError(n); if (ue) { err('authRegErr', ue); $('authUser')?.focus(); return; }
    email = e; username = n;
    rememberIdentity();
    showCodeStep('register');
  }

  async function doVerifyCode() {
    if (busy) return;
    const code = val('authCodeIn');
    clearErrors();
    if (!CODE_RE.test(code)) { err('authCodeErr', 'Enter the 6-digit master code.'); return; }

    setBusy(true);
    try {
      const res = await WireClient.verifyCode(email, code, username);
      // The name on file wins — someone cannot rename themselves by retyping.
      if (res && res.name) { username = res.name; rememberIdentity(); }

      // Registering an email that already has an MPIN is not registration, it
      // is a sign-in. Say so rather than pushing them through a reset they did
      // not ask for and quietly replacing a PIN they may still know.
      if (gatePurpose === 'register' && res && res.hasMpin) {
        showSigninStep();
        err('authSigninErr', 'That email is already registered. Sign in with your MPIN, or use "Forgot MPIN?" if you cannot remember it.');
        return;
      }
      showMpinStep();
    } catch (e2) {
      err('authCodeErr', e2.message || 'That master code was not accepted.');
      const c = $('authCodeIn'); if (c) { c.value = ''; c.focus(); }
    } finally {
      setBusy(false);
    }
  }

  async function doMpin() {
    if (busy) return;
    const a = val('authMpin1'), b = val('authMpin2');
    clearErrors();
    if (!MPIN_RE.test(a)) { err('authMpinErr', 'MPIN must be exactly 6 digits.'); $('authMpin1')?.focus(); return; }
    if (a !== b) { err('authMpinErr', 'The two MPINs do not match.'); $('authMpin2')?.focus(); return; }

    setBusy(true);
    try {
      if (gatePurpose === 'reset') await WireClient.resetMpin(a);
      else await WireClient.setMpin(a);
      enter();
    } catch (e2) {
      ['authMpin1', 'authMpin2'].forEach(id => { const e3 = $(id); if (e3) e3.value = ''; });
      // Only a genuinely dead reg token sends you back to the master code. The
      // message is set AFTER the step change, because showing a step clears
      // the error boxes.
      if (e2 && e2.code === 'REG_EXPIRED') {
        showCodeStep(gatePurpose);
        err('authCodeErr', e2.message || 'That took too long. Enter the master code again.');
      } else {
        err('authMpinErr', e2.message || 'That did not work. Try again.');
        $('authMpin1')?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  // Forgotten MPIN: the master code is the only safe way back in, which is why
  // it is kept rather than retired along with per-session use.
  function doForgot() {
    const e = val('authEmailIn').toLowerCase() || email;
    const ee = emailError(e);
    if (ee) { err('authSigninErr', 'Enter your email first, then use "Forgot MPIN?".'); $('authEmailIn')?.focus(); return; }
    email = e;
    rememberIdentity();
    showCodeStep('reset');
  }

  function doShowRegister() {
    show('authRegister');
    const e = $('authEmail'); if (e) e.value = val('authEmailIn').toLowerCase() || email;
    const u = $('authUser'); if (u) u.value = username;
  }

  // ── identity memory (convenience only, never a credential) ────────────────
  function rememberIdentity() {
    try { localStorage.setItem(IDENT_KEY, JSON.stringify({ email, username })); } catch (e) {}
  }
  function recallIdentity() {
    try {
      const raw = localStorage.getItem(IDENT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && d.email) { email = d.email; username = d.username || ''; }
    } catch (e) {}
  }

  // ── gate open / close ─────────────────────────────────────────────────────
  const publicAccount = () => ({ email, username });

  function enter() {
    signedIn = true;
    const gate = $('authGate'); if (gate) gate.style.display = 'none';
    const app = $('app-root'); if (app) app.hidden = false;
    onSignedIn?.(publicAccount());
  }

  function signOut() {
    signedIn = false;
    WireClient.clearTokens();
    const app = $('app-root'); if (app) app.hidden = true;
    const gate = $('authGate'); if (gate) gate.style.display = 'grid';
    showSigninStep();
  }

  // Settings changed the name, or the MPIN change issued a fresh token.
  function setUsername(name){
    if (!name) return;
    username = name;
    rememberIdentity();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  function digitsOnly(id) {
    const e = $(id); if (!e) return;
    e.addEventListener('input', () => { e.value = e.value.replace(/\D/g, '').slice(0, 6); });
  }
  function onEnter(id, fn) {
    const e = $(id); if (!e) return;
    e.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); fn(); } });
  }
  function click(id, fn) { $(id)?.addEventListener('click', fn); }

  function init(opts) {
    onSignedIn = opts?.onSignedIn || null;

    ['authPinIn', 'authCodeIn', 'authMpin1', 'authMpin2'].forEach(digitsOnly);

    click('authSigninGo', doSignin);
    onEnter('authEmailIn', () => $('authPinIn')?.focus());
    onEnter('authPinIn', doSignin);
    click('authNeedRegister', doShowRegister);
    click('authForgot', doForgot);

    click('authRegisterGo', doRegisterIdentify);
    onEnter('authEmail', () => $('authUser')?.focus());
    onEnter('authUser', doRegisterIdentify);
    click('authRegisterBack', showSigninStep);

    click('authVerifyCode', doVerifyCode);
    onEnter('authCodeIn', doVerifyCode);
    click('authCodeBack', showSigninStep);

    click('authMpinGo', doMpin);
    onEnter('authMpin1', () => $('authMpin2')?.focus());
    onEnter('authMpin2', doMpin);

    restore();
  }

  // A session token that is still alive means straight in. It lives in
  // sessionStorage, so closing the tab ends it.
  function restore() {
    recallIdentity();
    if (WireClient.hasSession()) { enter(); return; }
    showSigninStep();
  }

  return {
    init,
    signOut,
    setUsername,
    isSignedIn: () => signedIn,
    current: () => (signedIn ? publicAccount() : null)
  };
})();

if (typeof window !== 'undefined') window.Auth = Auth;
