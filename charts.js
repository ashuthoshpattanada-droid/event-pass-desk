/* =====================================================================
   GatePass // Event Ops — charts.js
   Registrations & admissions over time (vanilla SVG, no libraries).
   Load AFTER app.js. It hooks into renderAdmin(), so it redraws on every
   refresh / admit automatically. app.js needs no changes.
   ===================================================================== */
'use strict';

(() => {
  if (typeof state === 'undefined' || typeof window.renderAdmin !== 'function') {
    console.warn('charts.js: load it after app.js');
    return;
  }

  const MIN = 60 * 1000;
  const STEPS = { '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN, '1d': 24 * 60 * MIN };
  const KEY_LABEL = { '5m': '5 min', '15m': '15 min', '1h': '1 hour', '1d': '1 day' };
  const MAX_BUCKETS = 96;
  const MIN_BUCKETS = 8;

  let mode = 'auto'; // auto | 5m | 15m | 1h | 1d

  const $ = (sel) => document.querySelector(sel);

  /* ---------- formatting ---------- */
  const fmtClock = (t) =>
    new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  const fmtDayLong = (t) =>
    new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  /* ---------- bucketing (aligned to local time) ---------- */
  function floorTo(t, key) {
    const d = new Date(t);
    if (key === '1d') d.setHours(0, 0, 0, 0);
    else if (key === '1h') d.setMinutes(0, 0, 0);
    else {
      const m = key === '5m' ? 5 : 15;
      d.setMinutes(Math.floor(d.getMinutes() / m) * m, 0, 0);
    }
    return d.getTime();
  }

  function nextStart(t, key) {
    if (key === '1d') {
      const d = new Date(t);
      d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    return t + STEPS[key];
  }

  function pickKey(span) {
    if (mode !== 'auto') return mode;
    if (span <= 2 * 60 * MIN) return '5m';
    if (span <= 12 * 60 * MIN) return '15m';
    if (span <= 3 * 24 * 60 * MIN) return '1h';
    return '1d';
  }

  function makeBuckets(startT, endT, key) {
    // Show only the most recent MAX_BUCKETS slots if the range is huge.
    const step = STEPS[key];
    if ((endT - startT) / step > MAX_BUCKETS) startT = endT - MAX_BUCKETS * step;

    const buckets = [];
    let t = floorTo(startT, key);
    let guard = 0;
    while (t <= endT && guard++ < 2000) {
      const end = nextStart(t, key);
      buckets.push({ start: t, end, count: 0 });
      t = end;
    }
    while (buckets.length < MIN_BUCKETS) {
      const last = buckets[buckets.length - 1];
      buckets.push({ start: last.end, end: nextStart(last.end, key), count: 0 });
    }
    return buckets;
  }

  function fill(buckets, times) {
    const first = buckets[0].start;
    const last = buckets[buckets.length - 1].end;
    for (const t of times) {
      if (t < first || t >= last) continue;
      for (let i = buckets.length - 1; i >= 0; i--) {
        if (t >= buckets[i].start) { buckets[i].count++; break; }
      }
    }
  }

  function rangeLabel(b, key, spansDays) {
    if (key === '1d') return fmtDayLong(b.start);
    const base = `${fmtClock(b.start)} – ${fmtClock(b.end)}`;
    return spansDays ? `${base} · ${fmtDay(b.start)}` : base;
  }

  /* ---------- SVG bar chart ---------- */
  function barsSvg(buckets, key, cls, spansDays) {
    const W = 640, H = 240, L = 36, R = 10, T = 24, B = 44;
    const iw = W - L - R;
    const ih = H - T - B;
    const n = buckets.length;

    const max = Math.max(1, ...buckets.map((b) => b.count));
    const step = max <= 4 ? 1 : Math.ceil(max / 4);
    const yMax = step * Math.max(1, Math.ceil(max / step));
    const y = (v) => T + ih - (v / yMax) * ih;

    const slot = iw / n;
    const barW = Math.min(slot * 0.7, 42);

    let out = `<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">`;

    // grid + y ticks
    for (let v = 0; v <= yMax; v += step) {
      out += `<line class="${v === 0 ? 'axis' : 'grid'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      out += `<text class="tick" x="${L - 8}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
    }

    // bars + hit areas
    buckets.forEach((b, i) => {
      const x = L + i * slot + (slot - barW) / 2;
      out += `<g class="col" data-i="${i}">`;
      out += `<rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${ih}"/>`;
      if (b.count > 0) {
        const h = Math.max(2, (b.count / yMax) * ih);
        out += `<rect class="bar ${cls}" x="${x}" y="${T + ih - h}" width="${barW}" height="${h}" rx="3"/>`;
        if (barW >= 14) out += `<text class="val" x="${x + barW / 2}" y="${T + ih - h - 6}">${b.count}</text>`;
      }
      out += `</g>`;
    });

    // x labels
    const maxLabels = Math.max(2, Math.floor(iw / 64));
    const every = Math.ceil(n / maxLabels);
    let prevLabelStart = null;
    for (let i = 0; i < n; i += every) {
      const b = buckets[i];
      const cx = L + i * slot + slot / 2;
      const main = key === '1d' ? fmtDay(b.start) : fmtClock(b.start);
      out += `<text class="tick" x="${cx}" y="${T + ih + 16}" text-anchor="middle">${main}</text>`;
      if (key !== '1d' && spansDays && (prevLabelStart === null || !sameDay(prevLabelStart, b.start))) {
        out += `<text class="tick tick--date" x="${cx}" y="${T + ih + 29}" text-anchor="middle">${fmtDay(b.start)}</text>`;
      }
      prevLabelStart = b.start;
    }

    return out + '</svg>';
  }

  /* ---------- render one panel ---------- */
  function renderPanel(id, statId, buckets, key, cls, noun, total, spansDays) {
    const el = $(id);
    const plot = el.querySelector('.chart__plot');
    const stat = $(statId);

    if (!total) {
      plot.innerHTML = `<div class="chart__empty">No ${noun} yet</div>`;
      stat.innerHTML = `<span><b>0</b> ${noun}</span>`;
      el._d = null;
      return;
    }

    plot.innerHTML = barsSvg(buckets, key, cls, spansDays);

    let peakI = 0;
    buckets.forEach((b, i) => { if (b.count > buckets[peakI].count) peakI = i; });
    const peak = buckets[peakI];
    stat.innerHTML =
      `<span><b>${total}</b> ${noun}</span>` +
      `<span>Peak <b>${peak.count}</b> · ${rangeLabel(peak, key, spansDays)}</span>`;

    el._d = { buckets, key, noun, spansDays };
  }

  /* ---------- tooltip ---------- */
  function bindTip(id) {
    const el = $(id);
    const tip = el.querySelector('.chart__tip');

    el.addEventListener('pointermove', (e) => {
      const col = e.target.closest('[data-i]');
      if (!col || !el._d) { tip.classList.remove('is-on'); return; }
      const { buckets, key, noun, spansDays } = el._d;
      const b = buckets[Number(col.dataset.i)];
      tip.innerHTML = `<b>${b.count}</b> ${noun}<span>${rangeLabel(b, key, spansDays)}</span>`;
      const r = el.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - r.left, 70), r.width - 70);
      tip.style.left = `${x}px`;
      tip.style.top = `${e.clientY - r.top - 10}px`;
      tip.classList.add('is-on');
    });
    el.addEventListener('pointerleave', () => tip.classList.remove('is-on'));
  }

  /* ---------- main ---------- */
  function renderCharts() {
    if (!$('#charts')) return;
    const list = state.attendees || [];

    const regTimes = list.map((a) => new Date(a.created_at).getTime()).filter(Number.isFinite);
    const admTimes = list
      .filter((a) => a.is_admitted && a.admitted_at)
      .map((a) => new Date(a.admitted_at).getTime())
      .filter(Number.isFinite);

    const all = [...regTimes, ...admTimes];
    const note = $('#slot-note');

    if (!all.length) {
      renderPanel('#chart-reg', '#stat-reg', [], '15m', 'bar--reg', 'registered', 0, false);
      renderPanel('#chart-adm', '#stat-adm', [], '15m', 'bar--adm', 'admitted', 0, false);
      note.textContent = 'Waiting for the first registration…';
      return;
    }

    const startT = Math.min(...all);
    const endT = Math.max(...all);
    const key = pickKey(endT - startT);
    const spansDays = !sameDay(startT, endT);

    // Same time axis for both charts so they line up.
    const regB = makeBuckets(startT, endT, key);
    const admB = regB.map((b) => ({ ...b, count: 0 }));
    fill(regB, regTimes);
    fill(admB, admTimes);

    renderPanel('#chart-reg', '#stat-reg', regB, key, 'bar--reg', 'registered', regTimes.length, spansDays);
    renderPanel('#chart-adm', '#stat-adm', admB, key, 'bar--adm', 'admitted', admTimes.length, spansDays);
    note.textContent = `People per ${KEY_LABEL[key]} slot${mode === 'auto' ? ' (auto)' : ''}`;
  }

  /* ---------- wire up ---------- */
  const originalRenderAdmin = window.renderAdmin;
  window.renderAdmin = function renderAdminWithCharts() {
    originalRenderAdmin();
    try { renderCharts(); } catch (err) { console.error('charts.js:', err); }
  };

  document.addEventListener('DOMContentLoaded', () => {
    bindTip('#chart-reg');
    bindTip('#chart-adm');

    $('#bucket-seg')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bucket]');
      if (!btn) return;
      mode = btn.dataset.bucket;
      document.querySelectorAll('#bucket-seg .seg__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      renderCharts();
    });
  });
})();
