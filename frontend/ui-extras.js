// FILE: frontend/ui-extras.js
// Small UI additions:
//  1. Resizable blotter columns (Time, Date, ID, Source) — drag the right edge of a header.
//  2. Sign-in banner telling trainees which releases to use. terminal.js calls
//     window.showSigninBanner() after every sign-in.
'use strict';

(() => {
  const KEY = 'tw_blotter_colw';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } };
  const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* storage unavailable */ } };

  function initColumnResize() {
    const widths = load();
    document.querySelectorAll('#blotter thead th').forEach(th => {
      const cls = ['c-time', 'c-date', 'c-id', 'c-src'].find(c => th.classList.contains(c));
      if (!cls) return;                       // Headline takes whatever is left
      if (widths[cls]) th.style.width = widths[cls] + 'px';
      const h = document.createElement('span');
      h.className = 'col-rs'; h.title = 'Drag to resize';
      th.appendChild(h);
      h.addEventListener('click', e => e.stopPropagation());   // don't trigger the column sort
      h.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
        document.body.style.cursor = 'col-resize';
        const move = (ev) => { th.style.width = Math.max(34, Math.round(w0 + ev.clientX - x0)) + 'px'; };
        const up = () => {
          document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
          widths[cls] = parseInt(th.style.width, 10); save(widths);
        };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
    });
  }

  window.showSigninBanner = function () {
    if (document.getElementById('signinBanner')) return;
    const b = document.createElement('div');
    b.id = 'signinBanner'; b.className = 'signin-banner';
    b.innerHTML = '<span class="sb-ico">ⓘ</span><span class="sb-txt"><b>Use press releases from US newswires</b> like PRN, PZO, etc. ' +
      'Companies’ IR documents are not optimised for newswires. If you upload one anyway, we’ll show it as accurately as we can.</span>' +
      '<button class="sb-x" title="Dismiss">✕</button>';
    b.querySelector('.sb-x').onclick = () => b.remove();
    document.body.appendChild(b);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initColumnResize); else initColumnResize();
})();
