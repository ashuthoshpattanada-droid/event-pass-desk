/* =====================================================================
   GatePass // Event Ops — app.js
   Vanilla ES6+ · Supabase JS v2 (loaded via CDN in index.html)
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------------
   1. CONFIG — paste your Supabase credentials here
   Dashboard → Project Settings → API
     • SUPABASE_URL      = "Project URL"           (https://xxxx.supabase.co)
     • SUPABASE_ANON_KEY = "anon / public" API key (NOT the service_role key)
   --------------------------------------------------------------------- */
const SUPABASE_URL = 'https://vigrnyqdsvbjpqtltndr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZpZ3JueXFkc3ZianBxdGx0bmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQwNzA4ODMsImV4cCI6MjEwOTY0Njg4M30.AMzv-KT9V-mjg19sDIwj6SptozIJ3uSabC6BZCJ-BzU';

const POLL_INTERVAL_MS = 8000;  // admin table auto-refresh (keeps multiple gate desks in sync)
const PASS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easier to read aloud
const PASS_RE = /^PASS-[A-Z0-9]{4}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CONFIG_OK =
  !SUPABASE_URL.includes('YOUR-PROJECT-REF') && !SUPABASE_ANON_KEY.startsWith('YOUR-');

const db = CONFIG_OK ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

/* ---------------------------------------------------------------------
   2. State + DOM helpers
   --------------------------------------------------------------------- */
const state = {
  event: null,          // { id, title, event_date, capacity }
  attendees: [],        // newest first
  filter: 'all',        // all | admitted | pending
  search: '',
  activeTab: 'register',
  pollTimer: null,
  admitting: new Set(), // attendee ids with an in-flight admit
  flashId: null,
  lastPass: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function fmtEventDate(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

/* ---------------------------------------------------------------------
   3. Toast engine
   --------------------------------------------------------------------- */
const TOAST_ICONS = { success: '✓', error: '✕', warning: '!', info: 'i' };

function toast(type, title, message = '', ttl = 4200) {
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <span class="toast__icon">${TOAST_ICONS[type] ?? 'i'}</span>
    <div><div class="toast__title">${esc(title)}</div>${message ? `<div class="toast__msg">${esc(message)}</div>` : ''}</div>`;
  $('#toasts').appendChild(el);

  const dismiss = () => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  const timer = setTimeout(dismiss, ttl);
  el.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

/* ---------------------------------------------------------------------
   4. Connection badge
   --------------------------------------------------------------------- */
function setConnection(status, text) {
  const badge = $('#conn-badge');
  badge.className = `conn conn--${status}`;
  $('#conn-text').textContent = text;
}

/* ---------------------------------------------------------------------
   5. Data layer
   --------------------------------------------------------------------- */
async function loadEvent() {
  const { data, error } = await db
    .from('events')
    .select('id, title, event_date, capacity')
    .order('event_date', { ascending: true });
  if (error) throw error;
  if (!data?.length) throw new Error('No events found. Run schema.sql — it seeds one event.');

  const today = new Date().toISOString().slice(0, 10);
  state.event = data.find((e) => e.event_date >= today) ?? data[data.length - 1];
}

async function fetchAttendees() {
  const { data, error } = await db
    .from('attendees')
    .select('*')
    .eq('event_id', state.event.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  state.attendees = data;
}

function upsertLocal(row) {
  const i = state.attendees.findIndex((a) => a.id === row.id);
  if (i >= 0) state.attendees[i] = row;
  else state.attendees.unshift(row);
}

/** Translate a Supabase/Postgres error into a user-friendly object. */
function parseDbError(error) {
  const msg = `${error?.message ?? ''} ${error?.details ?? ''}`;
  if (error?.code === '23505') {
    if (msg.includes('student_unique')) return { kind: 'dup', title: 'Already registered', text: 'This Student ID already has a pass for this event.' };
    if (msg.includes('email_unique')) return { kind: 'dup', title: 'Already registered', text: 'This email already has a pass for this event.' };
    if (msg.includes('pass_code')) return { kind: 'code', title: 'Code collision', text: 'Retrying with a new code…' };
    return { kind: 'dup', title: 'Duplicate entry', text: 'This registration already exists.' };
  }
  if (msg.includes('EVENT_FULL')) return { kind: 'full', title: 'Event is full', text: 'No capacity left for this event.' };
  if (error?.code === '23514') return { kind: 'invalid', title: 'Invalid data', text: 'Please check the values you entered.' };
  if (error?.code === '42501') return { kind: 'perm', title: 'Permission denied', text: 'Check the RLS policies from schema.sql.' };
  if (/fetch|network|failed/i.test(msg)) return { kind: 'net', title: 'Network error', text: 'Could not reach Supabase. Check your connection.' };
  return { kind: 'unknown', title: 'Something went wrong', text: error?.message || 'Unexpected error.' };
}

/* ---------------------------------------------------------------------
   6. Tab 1 — Registration
   --------------------------------------------------------------------- */
function generatePassCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  // 256 % 32 === 0, so mapping bytes onto a 32-char alphabet is unbiased.
  const suffix = [...bytes].map((b) => PASS_ALPHABET[b % PASS_ALPHABET.length]).join('');
  return `PASS-${suffix}`;
}

function renderEventHeader() {
  $('#event-title').textContent = state.event.title;
  $('#event-date').textContent = fmtEventDate(state.event.event_date);
}

function setFieldError(name, message) {
  const input = $(`#${name}`);
  const err = $(`#err-${name}`);
  err.textContent = message || '';
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function validateForm(values) {
  const errors = {};
  if (!values.full_name) errors.full_name = 'Full name is required.';
  else if (values.full_name.length < 2) errors.full_name = 'Please enter your full name.';

  if (!values.email) errors.email = 'College email is required.';
  else if (!EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address.';

  if (!values.student_id) errors.student_id = 'Student ID / USN is required.';
  else if (!/^[A-Za-z0-9\-_/.]{3,30}$/.test(values.student_id)) errors.student_id = 'Use letters and numbers only (3–30 chars).';

  return errors;
}

function setLoading(btn, loading) {
  btn.classList.toggle('is-loading', loading);
  btn.disabled = loading;
}

async function insertAttendee(values) {
  // Retry a few times on the (very unlikely) pass_code collision.
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await db
      .from('attendees')
      .insert({ ...values, event_id: state.event.id, pass_code: generatePassCode() })
      .select()
      .single();

    if (!error) return { data };
    const parsed = parseDbError(error);
    if (parsed.kind !== 'code') return { error: parsed };
  }
  return { error: { kind: 'unknown', title: 'Could not generate a code', text: 'Please try again.' } };
}

async function handleRegister(e) {
  e.preventDefault();
  if (!db || !state.event) return toast('error', 'Not connected', 'Database is not ready yet.');

  const values = {
    full_name: $('#full_name').value.trim().replace(/\s+/g, ' '),
    email: $('#email').value.trim().toLowerCase(),
    student_id: $('#student_id').value.trim().toUpperCase(),
  };

  const errors = validateForm(values);
  ['full_name', 'email', 'student_id'].forEach((f) => setFieldError(f, errors[f]));
  if (Object.keys(errors).length) {
    toast('warning', 'Check the form', 'Fix the highlighted fields and try again.');
    $(`#${Object.keys(errors)[0]}`).focus();
    return;
  }

  const btn = $('#register-btn');
  setLoading(btn, true);
  try {
    const { data, error } = await insertAttendee(values);
    if (error) {
      const toastType = error.kind === 'dup' || error.kind === 'full' ? 'warning' : 'error';
      toast(toastType, error.title, error.text);
      if (error.kind === 'dup') {
        const field = error.text.includes('email') ? 'email' : 'student_id';
        setFieldError(field, error.text);
      }
      return;
    }
    showPass(data);
    toast('success', 'Pass generated', `Welcome, ${data.full_name.split(' ')[0]}!`);
  } catch (err) {
    console.error(err);
    toast('error', 'Registration failed', err.message || 'Unexpected error.');
  } finally {
    setLoading(btn, false);
  }
}

function showPass(row) {
  state.lastPass = row;
  $('#t-event').textContent = state.event.title;
  $('#t-date').textContent = fmtEventDate(state.event.event_date);
  $('#t-name').textContent = row.full_name;
  $('#t-sid').textContent = row.student_id;
  $('#t-code').textContent = row.pass_code;
  $('#register-card').classList.add('hidden');
  $('#pass-wrap').classList.remove('hidden');
}

function resetRegistration() {
  $('#register-form').reset();
  ['full_name', 'email', 'student_id'].forEach((f) => setFieldError(f, ''));
  $('#pass-wrap').classList.add('hidden');
  $('#register-card').classList.remove('hidden');
  $('#full_name').focus();
}

async function copyPassCode() {
  const code = $('#t-code').textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
    } else {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('success', 'Copied', `${code} is on your clipboard.`, 2200);
  } catch {
    toast('error', 'Copy failed', 'Select the code and copy it manually.');
  }
}

/* ---------------------------------------------------------------------
   7. Tab 2 — Gate Verification Desk
   --------------------------------------------------------------------- */
function setMetric(id, value) {
  const el = $(id);
  const next = String(value);
  if (el.textContent !== next) {
    el.textContent = next;
    el.classList.remove('bump');
    void el.offsetWidth; // restart animation
    el.classList.add('bump');
  }
}

function renderMetrics() {
  const total = state.attendees.length;
  const admitted = state.attendees.filter((a) => a.is_admitted).length;
  const pending = total - admitted;
  const cap = state.event?.capacity ?? 0;
  const remaining = Math.max(cap - total, 0);
  const pct = total ? Math.round((admitted / total) * 100) : 0;

  setMetric('#m-total', total);
  setMetric('#m-admitted', admitted);
  setMetric('#m-pending', pending);
  $('#m-total-sub').textContent = cap ? `of ${cap} capacity` : '';
  $('#m-admitted-sub').textContent = total ? `${pct}% of registered` : '';
  $('#m-remaining').textContent = `${remaining} spots remaining`;
}

function filteredAttendees() {
  const q = state.search.trim().toLowerCase();
  return state.attendees.filter((a) => {
    if (state.filter === 'admitted' && !a.is_admitted) return false;
    if (state.filter === 'pending' && a.is_admitted) return false;
    if (!q) return true;
    return (
      a.full_name.toLowerCase().includes(q) ||
      a.student_id.toLowerCase().includes(q) ||
      a.pass_code.toLowerCase().includes(q)
    );
  });
}

function rowHtml(a) {
  const admitting = state.admitting.has(a.id);
  const status = a.is_admitted
    ? `<span class="badge badge--ok">Admitted</span><span class="status-time">${esc(fmtTime(a.admitted_at))}</span>`
    : `<span class="badge badge--pending">Pending</span>`;
  const action = a.is_admitted
    ? `<button class="btn btn-success btn-sm" disabled aria-label="Already admitted">✓ Admitted</button>`
    : `<button class="btn btn-primary btn-sm" data-admit="${a.id}" ${admitting ? 'disabled' : ''}>${admitting ? 'Admitting…' : 'Admit'}</button>`;

  return `
    <tr data-id="${a.id}" class="${state.flashId === a.id ? 'row-flash' : ''}">
      <td><div class="cell-name">${esc(a.full_name)}</div><div class="cell-sub">${esc(a.email)}</div></td>
      <td class="mono">${esc(a.student_id)}</td>
      <td><code class="code-chip">${esc(a.pass_code)}</code></td>
      <td class="cell-time">${esc(fmtDateTime(a.created_at))}</td>
      <td>${status}</td>
      <td class="td-action">${action}</td>
    </tr>`;
}

function renderTable() {
  const rows = filteredAttendees();
  $('#attendee-rows').innerHTML = rows.map(rowHtml).join('');
  const empty = $('#empty-state');
  empty.classList.toggle('hidden', rows.length > 0);
  empty.textContent = state.attendees.length
    ? 'No attendees match your search / filter.'
    : 'No registrations yet.';
  state.flashId = null;
}

function renderAdmin() {
  renderMetrics();
  renderTable();
}

async function refreshAdmin({ silent = false } = {}) {
  if (!db || !state.event) return;
  try {
    await fetchAttendees();
    renderAdmin();
    setConnection('online', 'Connected');
  } catch (err) {
    console.error(err);
    setConnection('offline', 'Offline');
    if (!silent) toast('error', 'Could not load attendees', parseDbError(err).text);
  }
}

async function admitById(id) {
  if (state.admitting.has(id)) return;
  state.admitting.add(id);
  renderTable();

  try {
    // `is_admitted = false` guard prevents two gate desks double-admitting.
    // admitted_at is stamped by the database trigger (server NOW()).
    const { data, error } = await db
      .from('attendees')
      .update({ is_admitted: true })
      .eq('id', id)
      .eq('is_admitted', false)
      .select();
    if (error) throw error;

    if (data.length) {
      upsertLocal(data[0]);
      state.flashId = data[0].id;
      toast('success', 'Admitted', `${data[0].full_name} · ${data[0].student_id}`);
    } else {
      await refreshAdmin({ silent: true });
      toast('warning', 'Already admitted', 'Someone else checked this attendee in.');
    }
  } catch (err) {
    console.error(err);
    const p = parseDbError(err);
    toast('error', p.title, p.text);
  } finally {
    state.admitting.delete(id);
    renderAdmin();
  }
}

async function quickAdmit(raw) {
  let code = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!code) return;
  if (/^[A-Z0-9]{4}$/.test(code)) code = `PASS-${code}`; // allow typing just the suffix
  if (!PASS_RE.test(code)) {
    return toast('warning', 'Invalid format', 'Pass codes look like PASS-A8F2.');
  }

  const input = $('#quick-input');
  const btn = $('#quick-btn');
  btn.disabled = true;
  try {
    const { data, error } = await db
      .from('attendees')
      .update({ is_admitted: true })
      .eq('event_id', state.event.id)
      .eq('pass_code', code)
      .eq('is_admitted', false)
      .select();
    if (error) throw error;

    if (data.length) {
      upsertLocal(data[0]);
      state.flashId = data[0].id;
      renderAdmin();
      toast('success', 'Admitted', `${data[0].full_name} · ${data[0].student_id}`);
      input.value = '';
      return;
    }

    // Nothing updated: either unknown code or already admitted.
    const { data: existing, error: lookupErr } = await db
      .from('attendees')
      .select('*')
      .eq('event_id', state.event.id)
      .eq('pass_code', code)
      .maybeSingle();
    if (lookupErr) throw lookupErr;

    if (existing) {
      upsertLocal(existing);
      renderAdmin();
      toast('warning', 'Already admitted', `${existing.full_name} checked in at ${fmtTime(existing.admitted_at)}.`);
    } else {
      toast('error', 'Pass not found', `${code} is not registered for this event.`);
    }
    input.select();
  } catch (err) {
    console.error(err);
    const p = parseDbError(err);
    toast('error', p.title, p.text);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

/* ---------------------------------------------------------------------
   8. Tabs + polling
   --------------------------------------------------------------------- */
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshAdmin({ silent: true });
  }, POLL_INTERVAL_MS);
}
function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function switchTab(name) {
  state.activeTab = name;
  $$('.tab').forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
  });
  $('#view-register').classList.toggle('hidden', name !== 'register');
  $('#view-admin').classList.toggle('hidden', name !== 'admin');

  if (name === 'admin') {
    refreshAdmin();
    startPolling();
    $('#quick-input').focus();
  } else {
    stopPolling();
  }
}

/* ---------------------------------------------------------------------
   9. Wire-up + boot
   --------------------------------------------------------------------- */
function bindEvents() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#register-form').addEventListener('submit', handleRegister);
  ['full_name', 'email', 'student_id'].forEach((f) =>
    $(`#${f}`).addEventListener('input', () => setFieldError(f, ''))
  );
  $('#copy-btn').addEventListener('click', copyPassCode);
  $('#register-another-btn').addEventListener('click', resetRegistration);

  $('#quick-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.event) return toast('error', 'Not connected', 'Database is not ready yet.');
    quickAdmit($('#quick-input').value);
  });

  $('#search-input').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTable();
  });

  $$('.pill').forEach((p) =>
    p.addEventListener('click', () => {
      state.filter = p.dataset.filter;
      $$('.pill').forEach((x) => x.classList.toggle('is-active', x === p));
      renderTable();
    })
  );

  $('#attendee-rows').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-admit]');
    if (btn) admitById(Number(btn.dataset.admit));
  });

  $('#refresh-btn').addEventListener('click', async () => {
    await refreshAdmin();
    toast('info', 'Refreshed', '', 1400);
  });
}

async function init() {
  bindEvents();

  if (!CONFIG_OK) {
    setConnection('offline', 'Not configured');
    $('#event-title').textContent = 'Setup required';
    $('#event-date').textContent = 'Add SUPABASE_URL and SUPABASE_ANON_KEY at the top of app.js.';
    $('#register-btn').disabled = true;
    toast('error', 'Supabase not configured', 'Edit the placeholders at the top of app.js.', 8000);
    return;
  }

  try {
    await loadEvent();
    renderEventHeader();
    setConnection('online', 'Connected');
  } catch (err) {
    console.error(err);
    setConnection('offline', 'Offline');
    $('#event-title').textContent = 'Could not load event';
    $('#event-date').textContent = 'Check your Supabase credentials and that schema.sql was run.';
    $('#register-btn').disabled = true;
    toast('error', 'Database connection failed', parseDbError(err).text, 7000);
  }
}

document.addEventListener('DOMContentLoaded', init);
