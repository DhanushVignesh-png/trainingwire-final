// Training Wire — Auth gate
//
// Three screens: email + username, then the master code, then the MPIN. The
// username is the author name on every snap this person files, so it is
// captured once at sign-in rather than typed into the toolbar each session.
//
// EVERY DECISION HERE IS THE SERVER'S. This file validates shapes so the user
// gets instant feedback on a typo, but it never decides whether a code or an
// MPIN is correct — code-verify, mpin-set, mpin-login and mpin-reset do, and
// the MPIN is PBKDF2-hashed in Table Storage where the browser cannot reach
// it. The earlier local build checked both in the browser, which meant anyone
// with devtools could walk straight in.
//
// WHY THE MASTER CODE EVERY TIME: mpin-set, mpin-login and mpin-reset all
// require a REG token, and only code-verify issues one. So the code is not a
// one-off registration step — it is the gate on every new session. The MPIN
// is what says which person you are once through it. A still-valid session
// token short-circuits all of this (see restore()).
console.log('Training Wire: Auth gate loaded');

const Auth = (() => {
  'use strict';

  const TR_DOMAIN = 'thomsonreuters.com';
  const IDENT_KEY = 'tw_ident';          // remembered email + username, convenience only

  const $ = (id) => document.getElementById(id);
  const val = (id) => ($(id)?.value || '').trim();

  let email = '';
  let username = '';
  let mpinMode = 'set';                  // 'set' | 'login' | 'reset'
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
  const STEPS = ['authRegister', 'authCode', 'authMpin'];
  const SUBS = {
    authRegister: 'Sign in with your Thomson Reuters email',
    authCode: 'Enter the master code you were given',
    authMpin: 'Your 6-digit MPIN'
  };

  function show(step) {
    STEPS.forEach(id => $(id)?.classList.toggle('on', id === step));
    const sub = $('authSub'); if (sub) sub.textContent = SUBS[step] || '';
    clearErrors();
    const first = $(step)?.querySelector('.auth-in:not([disabled])');
    if (first) setTimeout(() => first.focus(), 50);
  }

  function clearErrors() {
    ['authRegErr', 'authCodeErr', 'authMpinErr'].forEach(id => { const e = $(id); if (e) e.textContent = ''; });
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

  function showCodeStep() {
    show('authCode');
    const note = $('authCodeNote');
    if (note) note.textContent = 'Signing in as ' + email + '.';
    const c = $('authCodeIn'); if (c) c.value = '';
  }

  function showMpinStep(mode) {
    mpinMode = mode;
    show('authMpin');
    const two = mode !== 'login';                       // set and reset both confirm
    $('authMpinConfirmWrap')?.classList.toggle('hid', !two);
    const note = $('authMpinNote');
    if (note) {
      note.textContent =
        mode === 'set'   ? 'Choose a 6-digit MPIN. You will use it to sign in from now on.' :
        mode === 'reset' ? 'Choose a new 6-digit MPIN. This replaces your old one.' :
                           'Enter your 6-digit MPIN.';
    }
    const btn = $('authMpinGo');
    if (btn) btn.textContent = mode === 'set' ? 'Set MPIN' : mode === 'reset' ? 'Reset MPIN' : 'Sign in';
    // Forgot only makes sense for someone who has one to forget.
    $('authForgot')?.classList.toggle('hid', mode !== 'login');
    ['authMpin1', 'authMpin2'].forEach(id => { const e = $(id); if (e) e.value = ''; });
  }

  // ── actions ───────────────────────────────────────────────────────────────
  // No network call: there is nothing to send. Validate and move on.
  function doIdentify() {
    if (busy) return;
    const e = val('authEmail').toLowerCase();
    const n = val('authUser');
    clearErrors();
    const ee = emailError(e); if (ee) { err('authRegErr', ee); $('authEmail')?.focus(); return; }
    const ue = usernameError(n); if (ue) { err('authRegErr', ue); $('authUser')?.focus(); return; }
    email = e; username = n;
    rememberIdentity();
    showCodeStep();
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
      showMpinStep(res && res.hasMpin ? 'login' : 'set');
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
    if (mpinMode !== 'login' && a !== b) { err('authMpinErr', 'The two MPINs do not match.'); $('authMpin2')?.focus(); return; }

    setBusy(true);
    try {
      if (mpinMode === 'set') await WireClient.setMpin(a);
      else if (mpinMode === 'reset') await WireClient.resetMpin(a);
      else await WireClient.loginMpin(a);
      enter();
    } catch (e2) {
      ['authMpin1', 'authMpin2'].forEach(id => { const e3 = $(id); if (e3) e3.value = ''; });
      // Only a genuinely dead reg token sends you back to the master code. A
      // wrong MPIN keeps you here — and the message is set AFTER any step
      // change, because showing a step clears the error boxes.
      if (e2 && e2.code === 'REG_EXPIRED') {
        showCodeStep();
        err('authCodeErr', e2.message || 'That took too long. Enter the master code again.');
      } else {
        err('authMpinErr', e2.message || 'That did not work. Try again.');
        $('authMpin1')?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  function doForgot() {
    // The reg token from code-verify is still live, so no extra gate is needed.
    showMpinStep('reset');
  }

  function doBackToIdentify() {
    show('authRegister');
    const e = $('authEmail'); if (e) e.value = email;
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
    doBackToIdentify();
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

    ['authCodeIn', 'authMpin1', 'authMpin2'].forEach(digitsOnly);

    click('authRegisterGo', doIdentify);
    onEnter('authEmail', doIdentify);
    onEnter('authUser', doIdentify);

    click('authVerifyCode', doVerifyCode);
    onEnter('authCodeIn', doVerifyCode);
    click('authCodeBack', doBackToIdentify);

    click('authMpinGo', doMpin);
    onEnter('authMpin1', () => { if (mpinMode === 'login') doMpin(); else $('authMpin2')?.focus(); });
    onEnter('authMpin2', doMpin);
    click('authForgot', doForgot);

    restore();
  }

  // A session token that is still alive means straight in — no code, no MPIN.
  // It lives in sessionStorage, so closing the tab ends it.
  function restore() {
    recallIdentity();
    if (WireClient.hasSession()) { enter(); return; }
    const e = $('authEmail'); if (e) e.value = email;
    const u = $('authUser'); if (u) u.value = username;
    show('authRegister');
  }

  return {
    init,
    signOut,
    isSignedIn: () => signedIn,
    current: () => (signedIn ? publicAccount() : null)
  };
})();

if (typeof window !== 'undefined') window.Auth = Auth;
