// Proposed AI tells on the Review tab: Approve tell and Reject tell.
// Served into the page only while AI_TELL_HUNT is on. The buttons post to the
// same card route as every other card; the server records one verdict per tell.
(function () {
  var NOTE = 'Approve records your verdict only. It does not change the ban list or the lint check; adding an approved tell is a separate step, made on a branch. Reject is recorded and this tell is never proposed again.';
  var ids = new Set();
  var list = document.getElementById('list');
  if (!list) return;
  function decorate() {
    list.querySelectorAll('article.card').forEach(function (el) {
      if (!ids.has(Number(el.dataset.id)) || el.dataset.tell === '1') return;
      el.dataset.tell = '1';
      el.querySelectorAll('[data-a=edit],[data-a=redo],[data-f=redo]').forEach(function (x) { x.hidden = true; });
      var a = el.querySelector('[data-a=approve]'); if (a) a.textContent = 'Approve tell';
      var r = el.querySelector('[data-a=reject]'); if (r) r.textContent = 'Reject tell';
      var f = el.querySelector('[data-f=reason]'); if (f) f.placeholder = 'Why (optional)';
      var n = el.querySelector('.next'); if (n) n.textContent = NOTE;
    });
  }
  fetch('/api/review/ai-tell-cards', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { ids: [] }; })
    .then(function (j) {
      ids = new Set(j.ids || []);
      decorate();
      new MutationObserver(decorate).observe(list, { childList: true, subtree: true });
    })
    .catch(function () {});
})();
