// FILE: frontend/auth.js
// Training Wire — authentication flow controller.
// Drives the three-step gate: email -> OTP -> MPIN (set or login). Talks only to
// WireClient. On success it hands control to the terminal by calling onAuthed().
// Every input is validated client-side before it ever hits the network, and every
// backend error is surfaced in plain language. No secrets are ever logged.
'use strict';

(function () {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const OTP_LEN = 6;
  const MPIN_LEN = 6;

  // Must match backend config.js ALLOWED_EMAIL_DOMAINS exactly.
  const ALLOWED_DOMAINS = ['thomsonreuters.com'];

  class AuthFlow {
    constructor(root, onAuthed) {
      this.root = root;
      this.onAuthed = onAuthed;
      this.email = '';
      this.mode = 'set';       // 'set' (new MPIN) | 'login' (existing MPIN)
      this._busy = false;
      this._resendTimer = null;
      this._resendLeft = 0;
    }

    // ── Entry point ──────────────────────────────────────────────────────────
    start() {
      // If a session already exists (tab refresh), skip straight to the terminal.
      if (window.WireClient.hasSession()) { this.onAuthed(); return; }
      this._renderEmail();
    }

    _domainOk(email) {
      const dom = email.split('@')[1] || '';
      return ALLOWED_DOMAINS.some((d) => dom.toLowerCase() === d.toLowerCase());
    }

    _setBusy(b) {
      this._busy = b;
      const btns = this.root.querySelectorAll('button');
      btns.forEach((el) => { el.disabled = b; });
      this.root.classList.toggle('is-busy', b);
    }

    _error(msg) {
      const box = this.root.querySelector('.auth-error');
      if (box) { box.textContent = msg || ''; box.style.display = msg ? 'block' : 'none'; }
    }

    _note(msg) {
      const box = this.root.querySelector('.auth-note');
      if (box) { box.textContent = msg || ''; box.style.display = msg ? 'block' : 'none'; }
    }

    // ── Step 1: email ────────────────────────────────────────────────────────
    _renderEmail() {
      this.root.innerHTML = `
        <div class="auth-card" role="dialog" aria-labelledby="auth-title">
          <div class="auth-brand">
            <div class="auth-logo">◆</div>
            <div class="auth-brandname">TRAINING&nbsp;WIRE</div>
          </div>
          <h1 id="auth-title" class="auth-title">Secure sign-in</h1>
          <p class="auth-sub">Enter your Thomson Reuters email to receive a one-time code.</p>
          <form class="auth-form" novalidate>
            <label class="auth-label" for="email">Work email</label>
            <input class="auth-input" id="email" name="email" type="email"
                   autocomplete="username" inputmode="email" spellcheck="false"
                   placeholder="you@thomsonreuters.com" autofocus />
            <div class="auth-error" role="alert" style="display:none"></div>
            <div class="auth-note" style="display:none"></div>
            <button class="auth-btn" type="submit">Send code</button>
          </form>
          <div class="auth-foot">Authorised training use only. Sessions are audited.</div>
        </div>`;
      const form = this.root.querySelector('form');
      const input = this.root.querySelector('#email');
      form.addEventListener('submit', (e) => { e.preventDefault(); this._submitEmail(input.value); });
    }

    async _submitEmail(raw) {
      if (this._busy) return;
      const email = String(raw || '').trim().toLowerCase();
      this._error('');
      if (!EMAIL_RE.test(email)) return this._error('Enter a valid email address.');
      if (!this._domainOk(email)) return this._error('Use your Thomson Reuters work email.');

      this._setBusy(true);
      try {
        await window.WireClient.requestOtp(email);
        this.email = email;
        this._renderOtp();
      } catch (err) {
        this._error(err.message || 'Could not send the code. Try again.');
      } finally {
        this._setBusy(false);
      }
    }

    // ── Step 2: OTP ──────────────────────────────────────────────────────────
    _renderOtp() {
      this.root.innerHTML = `
        <div class="auth-card" role="dialog" aria-labelledby="auth-title">
          <div class="auth-brand">
            <div class="auth-logo">◆</div>
            <div class="auth-brandname">TRAINING&nbsp;WIRE</div>
          </div>
          <h1 id="auth-title" class="auth-title">Enter your code</h1>
          <p class="auth-sub">We sent a ${OTP_LEN}-digit code to <b>${this._escape(this.email)}</b>.</p>
          <form class="auth-form" novalidate>
            <label class="auth-label" for="otp">One-time code</label>
            <input class="auth-input auth-code" id="otp" name="otp" type="text"
                   inputmode="numeric" autocomplete="one-time-code" maxlength="${OTP_LEN}"
                   pattern="[0-9]*" placeholder="••••••" autofocus />
            <div class="auth-error" role="alert" style="display:none"></div>
            <div class="auth-note" style="display:none"></div>
            <button class="auth-btn" type="submit">Verify</button>
            <button class="auth-btn auth-btn-ghost" type="button" data-resend disabled>Resend code</button>
            <button class="auth-btn auth-btn-link" type="button" data-back>Use a different email</button>
          </form>
        </div>`;

      const form = this.root.querySelector('form');
      const input = this.root.querySelector('#otp');
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, OTP_LEN); });
      form.addEventListener('submit', (e) => { e.preventDefault(); this._submitOtp(input.value); });
      this.root.querySelector('[data-back]').addEventListener('click', () => this._renderEmail());
      this.root.querySelector('[data-resend]').addEventListener('click', () => this._resend());
      this._startResendCooldown(30);
    }

    _startResendCooldown(secs) {
      this._resendLeft = secs;
      const btn = this.root.querySelector('[data-resend]');
      if (this._resendTimer) clearInterval(this._resendTimer);
      const tick = () => {
        if (!btn) return;
        if (this._resendLeft <= 0) {
          clearInterval(this._resendTimer);
          btn.disabled = false;
          btn.textContent = 'Resend code';
        } else {
          btn.disabled = true;
          btn.textContent = `Resend code (${this._resendLeft}s)`;
          this._resendLeft -= 1;
        }
      };
      tick();
      this._resendTimer = setInterval(tick, 1000);
    }

    async _resend() {
      if (this._busy) return;
      this._error(''); this._note('');
      this._setBusy(true);
      try {
        await window.WireClient.requestOtp(this.email);
        this._note('A new code is on its way.');
        this._startResendCooldown(30);
      } catch (err) {
        this._error(err.message || 'Could not resend the code.');
      } finally {
        this._setBusy(false);
      }
    }

    async _submitOtp(raw) {
      if (this._busy) return;
      const otp = String(raw || '').trim();
      this._error('');
      if (otp.length !== OTP_LEN || /\D/.test(otp)) return this._error(`Enter the ${OTP_LEN}-digit code.`);

      this._setBusy(true);
      try {
        const res = await window.WireClient.verifyOtp(this.email, otp);
        // Backend tells us whether this account already has an MPIN.
        this.mode = res.hasMpin ? 'login' : 'set';
        if (this._resendTimer) clearInterval(this._resendTimer);
        this._renderMpin();
      } catch (err) {
        this._error(err.message || 'That code was incorrect or expired.');
      } finally {
        this._setBusy(false);
      }
    }

    // ── Step 3: MPIN ─────────────────────────────────────────────────────────
    _renderMpin() {
      const setting = this.mode === 'set';
      this.root.innerHTML = `
        <div class="auth-card" role="dialog" aria-labelledby="auth-title">
          <div class="auth-brand">
            <div class="auth-logo">◆</div>
            <div class="auth-brandname">TRAINING&nbsp;WIRE</div>
          </div>
          <h1 id="auth-title" class="auth-title">${setting ? 'Create your MPIN' : 'Enter your MPIN'}</h1>
          <p class="auth-sub">${setting
            ? `Set a ${MPIN_LEN}-digit PIN. You'll use it to sign in from now on.`
            : `Enter your ${MPIN_LEN}-digit PIN to continue.`}</p>
          <form class="auth-form" novalidate>
            <label class="auth-label" for="mpin">${setting ? 'New MPIN' : 'MPIN'}</label>
            <input class="auth-input auth-code" id="mpin" name="mpin" type="password"
                   inputmode="numeric" autocomplete="${setting ? 'new-password' : 'current-password'}"
                   maxlength="${MPIN_LEN}" pattern="[0-9]*" placeholder="••••••" autofocus />
            ${setting ? `
            <label class="auth-label" for="mpin2">Confirm MPIN</label>
            <input class="auth-input auth-code" id="mpin2" name="mpin2" type="password"
                   inputmode="numeric" autocomplete="new-password"
                   maxlength="${MPIN_LEN}" pattern="[0-9]*" placeholder="••••••" />` : ''}
            <div class="auth-error" role="alert" style="display:none"></div>
            <div class="auth-note" style="display:none"></div>
            <button class="auth-btn" type="submit">${setting ? 'Set MPIN & enter' : 'Sign in'}</button>
          </form>
        </div>`;

      const form = this.root.querySelector('form');
      const p1 = this.root.querySelector('#mpin');
      const p2 = this.root.querySelector('#mpin2');
      [p1, p2].filter(Boolean).forEach((el) => {
        el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, '').slice(0, MPIN_LEN); });
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        setting ? this._submitSetMpin(p1.value, p2.value) : this._submitLoginMpin(p1.value);
      });
    }

    _weakMpin(pin) {
      // Reject the obvious ones: all-same and simple sequences.
      if (/^(\d)\1{5}$/.test(pin)) return true;
      const seqUp = '0123456789';
      const seqDn = '9876543210';
      if (seqUp.includes(pin) || seqDn.includes(pin)) return true;
      return false;
    }

    async _submitSetMpin(a, b) {
      if (this._busy) return;
      this._error('');
      if (a.length !== MPIN_LEN || /\D/.test(a)) return this._error(`MPIN must be ${MPIN_LEN} digits.`);
      if (a !== b) return this._error('The two PINs do not match.');
      if (this._weakMpin(a)) return this._error('Choose a less predictable PIN.');

      this._setBusy(true);
      try {
        await window.WireClient.setMpin(a);
        this.onAuthed();
      } catch (err) {
        this._error(err.message || 'Could not set your MPIN. Try again.');
        this._setBusy(false);
      }
    }

    async _submitLoginMpin(a) {
      if (this._busy) return;
      this._error('');
      if (a.length !== MPIN_LEN || /\D/.test(a)) return this._error(`Enter your ${MPIN_LEN}-digit MPIN.`);

      this._setBusy(true);
      try {
        await window.WireClient.loginMpin(a);
        this.onAuthed();
      } catch (err) {
        this._error(err.message || 'Incorrect MPIN.');
        this._setBusy(false);
      }
    }

    _escape(s) {
      const d = document.createElement('div');
      d.textContent = String(s || '');
      return d.innerHTML;
    }
  }

  window.AuthFlow = AuthFlow;
})();