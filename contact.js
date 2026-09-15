/* Work with Eli — one small form, shared by every page.

   The site has no server of its own, and it is not getting one for this:
   the form hands the message to FormSubmit, which forwards it to my inbox
   as an email. That is the only thing on these pages that ever leaves the
   device, it happens only when you press Send, and it carries only what you
   typed into the form. Your documents are never part of it.

   If the hand-off fails for any reason, nothing is lost: the same message
   is offered as a ready-made email instead. */
(() => {
  const $ = s => document.querySelector(s);
  const sheet = $('#contactSheet');
  if (!sheet) return;
  const form = $('#contactForm');
  const ENDPOINT = 'https://formsubmit.co/ajax/otterholteli@gmail.com';
  const MAILTO = 'mailto:otterholteli@gmail.com';

  const show = state => {
    sheet.querySelectorAll('[data-state]').forEach(el => { el.hidden = el.dataset.state !== state; });
  };
  const open = () => {
    show('form');
    sheet.hidden = false;
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) setTimeout(() => $('#cName')?.focus(), 0);
  };
  const close = () => { sheet.hidden = true; };

  document.querySelectorAll('[data-contact-open]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    /* another sheet may be underneath — the "why" one — and two open at
       once is a stack of curtains; close it first */
    document.querySelectorAll('.sheet-wrap').forEach(w => { if (w !== sheet) w.hidden = true; });
    open();
  }));
  sheet.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) close(); });

  const mailtoFor = (name, email, msg) =>
    `${MAILTO}?subject=${encodeURIComponent('Building something simple')}&body=${encodeURIComponent(`${msg}\n\n— ${name}${email ? ` (${email})` : ''}`)}`;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#cName').value.trim();
    const email = $('#cEmail').value.trim();
    const msg = $('#cMsg').value.trim();
    if (!msg) { $('#cMsg').focus(); return; }
    if (form.querySelector('[name="_honey"]')?.value) return;          // a bot filled the hidden field
    const btn = $('#cSend');
    btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Sending…';
    let ok = false;
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          name, email: email || 'no-reply@fillandsign.local', message: msg,
          _subject: `Work with Eli — ${name || 'someone'} has a job in mind`,
          _template: 'table', _captcha: 'false', _replyto: email || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      ok = r.ok && String(j.success) === 'true';
    } catch (_) { ok = false; }
    btn.disabled = false; btn.textContent = btn.dataset.label;
    if (ok) { form.reset(); show('sent'); return; }
    $('#cFallback').href = mailtoFor(name, email, msg);
    show('failed');
  });
})();
