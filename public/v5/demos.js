// Sample-data demos. Everything here is scripted illustration, not live quotes.
(function () {
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var P = [
    { n: 'Northline Manufacturing', p: 445, d: 16 },
    { n: 'Apex CNC', p: 487, d: 12 },
    { n: 'Mesa Precision', p: 525, d: 9 },
    { n: 'ForgeWorks', p: 558, d: 11 },
    { n: 'Axis Manufacturing', p: 610, d: 7 },
    { n: 'Summit Prototype', p: 690, d: 5 }
  ];
  var usd = function (v) { return '$' + v.toLocaleString('en-US'); };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function onView(el, fn) {
    if (!('IntersectionObserver' in window)) { fn(); return; }
    var io = new IntersectionObserver(function (e) { if (e[0].isIntersecting) { io.disconnect(); fn(); } }, { threshold: 0.35 });
    io.observe(el);
  }

  // ---- demo 1: specs read from drawing ----
  (function () {
    var root = $('#demo1'), lis = $$('.spec li', root), hl = $$('.hl', root), timers = [];
    function clear() { timers.forEach(clearTimeout); timers = []; }
    function reset() { clear(); lis.forEach(function (l) { l.classList.remove('on'); }); hl.forEach(function (h) { h.classList.remove('on'); }); }
    function show(i) { lis[i].classList.add('on'); var h = hl[i]; if (h) h.classList.add('on'); }
    function play() { reset(); lis.forEach(function (_, i) { timers.push(setTimeout(function () { show(i); }, 500 + i * 650)); }); }
    $('[data-replay]', root).addEventListener('click', function () { reduced ? lis.forEach(function (_, i) { show(i); }) : play(); });
    if (reduced) lis.forEach(function (_, i) { show(i); }); else onView(root, play);
  })();

  // ---- demo 2: parallel requests ----
  (function () {
    var root = $('#demo2'), body = $('#d2body'), cnt = $('#d2n'), timers = [];
    body.innerHTML = P.map(function (r, i) {
      return '<tr data-i="' + i + '"><td>' + r.n + '</td><td><div class="st">Queued</div><div class="pbar"><i></i></div></td><td class="r p">&ndash;</td><td class="r d">&ndash;</td></tr>';
    }).join('');
    var rows = $$('tr', body);
    // scripted order; durations are illustration only
    var order = [2, 4, 1, 5, 3, 0], sent = [150, 250, 350, 450, 550, 650];
    function done(i) {
      var r = rows[i]; r.querySelector('.st').textContent = 'Quote received'; r.querySelector('.st').classList.add('done');
      r.querySelector('.pbar i').style.width = '100%';
      r.querySelector('.p').textContent = usd(P[i].p); r.querySelector('.d').textContent = P[i].d + ' d';
    }
    function reset() {
      timers.forEach(clearTimeout); timers = []; cnt.textContent = '0';
      rows.forEach(function (r) { var s = r.querySelector('.st'); s.textContent = 'Queued'; s.classList.remove('done'); r.querySelector('.pbar i').style.width = '0'; r.querySelector('.p').innerHTML = '&ndash;'; r.querySelector('.d').innerHTML = '&ndash;'; });
    }
    function play() {
      reset();
      rows.forEach(function (r, i) { timers.push(setTimeout(function () { r.querySelector('.st').textContent = 'Request sent'; r.querySelector('.pbar i').style.width = '70%'; }, sent[i])); });
      order.forEach(function (idx, k) { timers.push(setTimeout(function () { done(idx); cnt.textContent = String(k + 1); }, 1500 + k * 520)); });
    }
    function all() { rows.forEach(function (_, i) { done(i); }); cnt.textContent = '6'; }
    $('[data-replay]', root).addEventListener('click', function () { reduced ? all() : play(); });
    if (reduced) all(); else onView(root, play);
  })();

  // ---- demo 3: compare ----
  (function () {
    var root = $('#demo3'), body = $('#d3body'), svg = $('#d3chart'), mode = 'price';
    body.innerHTML = P.map(function (r, i) { return '<tr data-i="' + i + '"><td>' + r.n + '</td><td class="r">' + usd(r.p) + '</td><td class="r">' + r.d + ' d</td></tr>'; }).join('');
    var W = 520, H = 250, L = 52, R = 16, T = 14, B = 38;
    var x = function (d) { return L + (d - 3) / (18 - 3) * (W - L - R); };
    var y = function (p) { return H - B - (p - 400) / (720 - 400) * (H - B - T); };
    var g = '';
    [400, 480, 560, 640, 720].forEach(function (p) { g += '<path d="M' + L + ' ' + y(p) + 'H' + (W - R) + '" stroke="#E0DBCE"/><text x="' + (L - 6) + '" y="' + (y(p) + 3) + '" text-anchor="end">$' + p + '</text>'; });
    [4, 8, 12, 16].forEach(function (d) { g += '<path d="M' + x(d) + ' ' + T + 'V' + (H - B) + '" stroke="#E0DBCE"/><text x="' + x(d) + '" y="' + (H - B + 14) + '" text-anchor="middle">' + d + ' d</text>'; });
    g += '<path d="M' + L + ' ' + (H - B) + 'H' + (W - R) + 'M' + L + ' ' + T + 'V' + (H - B) + '" stroke="#1b1915"/>';
    g += '<text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">LEAD TIME</text><text x="' + L + '" y="' + (T - 3) + '">PRICE</text>';
    P.forEach(function (r, i) {
      var lx = i === 5 ? -8 : 8, anchor = i === 5 ? 'end' : 'start';
      g += '<g data-i="' + i + '"><circle class="pt" cx="' + x(r.d) + '" cy="' + y(r.p) + '" r="4.5"/><text class="lb" x="' + (x(r.d) + lx) + '" y="' + (y(r.p) - 7) + '" text-anchor="' + anchor + '">' + r.n.split(' ')[0] + '</text></g>';
    });
    svg.innerHTML = g;
    function paint() {
      var best = 0;
      P.forEach(function (r, i) { if (mode === 'price' ? r.p < P[best].p : r.d < P[best].d) best = i; });
      $$('tr', body).forEach(function (tr, i) { tr.classList.toggle('pick', i === best); });
      $$('g[data-i]', svg).forEach(function (el, i) { el.querySelector('.pt').classList.toggle('pick', i === best); el.querySelector('.lb').classList.toggle('pick', i === best); });
    }
    $$('.seg button', root).forEach(function (b) { b.addEventListener('click', function () { mode = b.dataset.mode; $$('.seg button', root).forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); }); paint(); }); });
    paint();
  })();

  // ---- demo 4: project ----
  (function () {
    var root = $('#demo4'), body = $('#d4body'), mode = 'price';
    var parts = [
      { n: 'FLT-BRACKET-01', q: 25, o: [[0, 445, 16], [5, 690, 5], [1, 487, 12]] },
      { n: 'FLT-SPACER-02', q: 100, o: [[0, 310, 14], [1, 356, 10], [4, 430, 6]] },
      { n: 'FLT-PLATE-03', q: 10, o: [[0, 705, 18], [2, 820, 10], [5, 990, 5]] }
    ];
    function paint() {
      var tot = 0, lead = 0, html = '';
      parts.forEach(function (pt) {
        var b = pt.o[0];
        pt.o.forEach(function (o) { if (mode === 'price' ? o[1] < b[1] : o[2] < b[2]) b = o; });
        tot += b[1]; lead = Math.max(lead, b[2]);
        html += '<tr><td>' + pt.n + '</td><td class="r">' + pt.q + '</td><td>' + P[b[0]].n + '</td><td class="r">' + usd(b[1]) + '</td><td class="r">' + b[2] + ' d</td></tr>';
      });
      body.innerHTML = html;
      $('#d4total').textContent = usd(tot);
      $('#d4lead').textContent = lead + ' d';
    }
    $$('.seg button', root).forEach(function (b) { b.addEventListener('click', function () { mode = b.dataset.mode; $$('.seg button', root).forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); }); paint(); }); });
    paint();
  })();
})();
