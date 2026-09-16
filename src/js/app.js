'use strict';
document.addEventListener('DOMContentLoaded', () => {

const elements = {
  bookSelect: document.getElementById('bookSelect'),
  chapterSelect: document.getElementById('chapterSelect'),
  verseSelect: document.getElementById('verseSelect'),
  statusBanner: document.getElementById('statusBanner'),
  themeToggle: document.getElementById('themeToggle'),
  passageDisplay: document.getElementById('passageDisplay'),
  scopeFilter: document.getElementById('scopeFilter'),
  badgeAll: document.getElementById('badgeAll'),
  badgeOT: document.getElementById('badgeOT'),
  badgeNT: document.getElementById('badgeNT')
};

if (!elements.bookSelect || !elements.chapterSelect || !elements.verseSelect) {
  console.error('[Biblia App] Faltan elementos críticos del DOM.');
  return;
}

const STORAGE_KEY = 'bibliaApp_notes';
const THEME_STORAGE_KEY = 'bibliaApp_theme';
const MAX_NOTE_LENGTH = 5000;
const MAX_STORAGE_SIZE = 4 * 1024 * 1024;
const STORAGE_WARNING_THRESHOLD = 0.80;
const FETCH_TIMEOUT_MS = 10000;

let currentScope = 'ALL';
const booksList = [];
let booksMap = new Map();
const chapterDataCache = new Map();
const autoSaveTimers = new Map();
let userNotes = {};
let renderSequence = 0;
let chapterSequence = 0;
let verseSequence = 0;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function debounce(fn, delay = 350) {
  let t = null;
  return (...a) => { if (t !== null) clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, delay); };
}
function getByteSize(t) { return new Blob([t]).size; }
function formatBytes(b) {
  if (b === 0) return '0 Bytes';
  const k = 1024, s = ['Bytes','KB','MB'], i = Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(2))+' '+s[i];
}
function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const c = new AbortController(), id = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(id));
}
function now() { return Date.now(); }

function normalizeNotes(notes) {
  const r = {};
  for (const [k, v] of Object.entries(notes)) {
    if (typeof v === 'string') r[k] = { value: v, _ts: now() };
    else if (typeof v === 'boolean') r[k] = { value: v, _ts: now() };
    else if (isPlainObject(v) && 'value' in v) r[k] = { ...v, _ts: typeof v._ts === 'number' ? v._ts : now() };
  }
  return r;
}

function loadNotesFromStorage() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return {};
    const p = JSON.parse(s);
    if (!isPlainObject(p)) throw new Error('Formato inválido.');
    return p;
  } catch (e) {
    console.warn('[Biblia App] Datos corruptos.', e);
    const backup = localStorage.getItem(STORAGE_KEY);
    setTimeout(() => {
      if (backup && confirm('Notas corruptas. ¿Descargar respaldo antes de reiniciar?')) {
        try {
          const b = new Blob([backup], { type: 'application/json' }), u = URL.createObjectURL(b), a = document.createElement('a');
          a.href = u; a.download = 'respaldo-notas-' + Date.now() + '.json';
          document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(u);
        } catch (x) { console.warn(x); }
      }
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      showWarning('Notas corruptas reiniciadas de forma segura.');
    }, 500);
    return {};
  }
}

function checkStorageHealth() {
  try {
    const s = getByteSize(JSON.stringify(userNotes)), p = s / MAX_STORAGE_SIZE;
    if (p >= STORAGE_WARNING_THRESHOLD)
      showWarning('Almacenamiento al ' + Math.round(p*100) + '% (' + formatBytes(s) + '). Exporta tus notas pronto.');
  } catch {}
}

function safeSaveNotes(n) {
  try {
    const s = JSON.stringify(n);
    if (getByteSize(s) > MAX_STORAGE_SIZE) { showError('Almacenamiento lleno. Exporta tus notas.', null); return false; }
    localStorage.setItem(STORAGE_KEY, s); checkStorageHealth(); return true;
  } catch (e) { console.error('[Biblia App] Error guardando:', e); showError('No se pudieron guardar tus notas.', null); return false; }
}

const saveNotesToStorage = debounce(() => safeSaveNotes(userNotes), 500);
userNotes = normalizeNotes(loadNotesFromStorage());
safeSaveNotes(userNotes);
checkStorageHealth();

window.addEventListener('storage', (ev) => {
  if (ev.key !== STORAGE_KEY) return;
  if (ev.newValue === null) { userNotes = {}; renderPassage(); return; }
  try {
    const p = JSON.parse(ev.newValue);
    if (!isPlainObject(p)) throw new Error('Sync inválido.');
    const merged = { ...p };
    for (const [k, lv] of Object.entries(userNotes)) {
      const rv = p[k];
      if (rv === undefined) merged[k] = lv;
      else if (isPlainObject(lv) && isPlainObject(rv) && typeof lv._ts === 'number' && typeof rv._ts === 'number')
        merged[k] = lv._ts >= rv._ts ? lv : rv;
    }
    if (JSON.stringify(merged) !== JSON.stringify(userNotes)) { userNotes = merged; renderPassage(); }
  } catch (e) { console.warn('[Biblia App] Sync error.', e); }
});

function getInitialTheme() {
  try { const s = localStorage.getItem(THEME_STORAGE_KEY); if (s === 'dark' || s === 'light') return s; } catch {}
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}
function saveTheme(t) { try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch {} }
function updateThemeIcon(t) {
  if (!elements.themeToggle) return;
  const d = t === 'dark';
  elements.themeToggle.textContent = d ? '☀️' : '🌙';
  elements.themeToggle.setAttribute('aria-label', d ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  elements.themeToggle.setAttribute('aria-pressed', String(d));
}
const savedTheme = getInitialTheme();
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeIcon(savedTheme);
elements.themeToggle?.addEventListener('click', () => {
  const c = document.documentElement.getAttribute('data-theme'), n = c === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', n); saveTheme(n); updateThemeIcon(n);
});
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    try { if (!localStorage.getItem(THEME_STORAGE_KEY)) { const n = e.matches ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', n); updateThemeIcon(n); } } catch {}
  });
}

async function loadManifest() {
  setLoadingState();
  try {
    const r = await fetchWithTimeout('./data/manifest.json', { cache: 'default', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error('No es JSON.');
    const data = await r.json();
    let raw = [];
    if (Array.isArray(data.books)) raw = data.books;
    else if (isPlainObject(data.books)) raw = Object.entries(data.books).map(([k,v]) => isPlainObject(v) ? { ...v, code: v.code||k, id: v.id||k } : null).filter(Boolean);
    if (!raw.length) throw new Error('Sin libros válidos.');
    const valid = raw.filter(b => isPlainObject(b) && (b.code||b.id) && typeof b.name === 'string');
    if (!valid.length) throw new Error('Sin libros válidos.');
    booksMap = new Map();
    valid.forEach(b => booksMap.set(String(b.code||b.id), b));
    booksList.length = 0; booksList.push(...booksMap.values());
    updateBadgeCounts(); clearStatus(); populateBooks();
  } catch (e) {
    console.error('[Biblia App] Error manifest:', e);
    showError(e.name === 'AbortError' ? 'Conexión tardó demasiado.' : 'Error al cargar libros.', loadManifest);
  }
}

async function fetchBookDetailData(bookId) {
  if (!bookId) return null;
  const k = String(bookId).toLowerCase();
  if (chapterDataCache.has(k)) return chapterDataCache.get(k);
  try {
    const r = await fetchWithTimeout('./data/biblia/' + encodeURIComponent(k) + '.json', { cache: 'default', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error('No es JSON.');
    const d = await r.json();
    if (!Array.isArray(d)) throw new Error('Estructura inválida.');
    chapterDataCache.set(k, d); return d;
  } catch (e) { console.warn('[Biblia App] No se pudo cargar ' + bookId, e); return null; }
}

function updateBadgeCounts() {
  const ot = booksList.filter(b => b.testament === 'OT').length, nt = booksList.filter(b => b.testament === 'NT').length;
  if (elements.badgeAll) elements.badgeAll.textContent = String(booksList.length);
  if (elements.badgeOT) elements.badgeOT.textContent = String(ot);
  if (elements.badgeNT) elements.badgeNT.textContent = String(nt);
}

function initScopeFilter() {
  if (!elements.scopeFilter) return;
  elements.scopeFilter.addEventListener('click', ev => {
    const t = ev.target; if (!(t instanceof Element)) return;
    const btn = t.closest('.scope-btn'); if (!btn || !btn.dataset.scope) return;
    if (btn.dataset.scope === currentScope) return;
    currentScope = btn.dataset.scope;
    elements.scopeFilter.querySelectorAll('.scope-btn').forEach(b => {
      const a = b.dataset.scope === currentScope; b.classList.toggle('active', a); b.setAttribute('aria-pressed', String(a));
    });
    populateBooks();
  });
}

function populateBooks() {
  elements.bookSelect.replaceChildren(new Option('-- Seleccionar Libro --', ''));
  const fb = booksList.filter(b => currentScope === 'ALL' || b.testament === currentScope);
  if (currentScope === 'ALL') {
    const gOT = document.createElement('optgroup'), gNT = document.createElement('optgroup');
    gOT.label = '— Antiguo Testamento —'; gNT.label = '— Nuevo Testamento —';
    fb.forEach(b => {
      const o = new Option(b.name, String(b.code||b.id));
      if (b.testament === 'OT') gOT.appendChild(o); else if (b.testament === 'NT') gNT.appendChild(o); else elements.bookSelect.appendChild(o);
    });
    if (gOT.children.length) elements.bookSelect.appendChild(gOT);
    if (gNT.children.length) elements.bookSelect.appendChild(gNT);
  } else { fb.forEach(b => elements.bookSelect.appendChild(new Option(b.name, String(b.code||b.id)))); }
  elements.bookSelect.disabled = fb.length === 0;
  resetSelect(elements.chapterSelect, 'Selecciona un libro');
  resetSelect(elements.verseSelect, 'Selecciona un capítulo');
  clearPassageDisplay();
}

async function updateChapters() {
  const seq = ++chapterSequence, bid = elements.bookSelect.value;
  if (!bid) { resetSelect(elements.chapterSelect, 'Selecciona un libro'); resetSelect(elements.verseSelect, 'Selecciona un capítulo'); clearPassageDisplay(); return; }
  const book = booksMap.get(bid); let tc = Number(book?.chapters || book?.chapterCount || 0);
  if (tc <= 0) { const cl = await fetchBookDetailData(bid); if (seq !== chapterSequence) return; if (Array.isArray(cl)) tc = cl.length; }
  if (tc <= 0) { resetSelect(elements.chapterSelect, 'Sin capítulos'); resetSelect(elements.verseSelect, 'Sin versículos'); return; }
  const d = new Option('-- Capítulo --', ''), opts = Array.from({ length: tc }, (_, i) => new Option('Capítulo ' + (i+1), String(i+1)));
  elements.chapterSelect.replaceChildren(d, ...opts); elements.chapterSelect.disabled = false;
  resetSelect(elements.verseSelect, 'Selecciona un capítulo'); clearPassageDisplay();
}

async function updateVerses() {
  const seq = ++verseSequence, bid = elements.bookSelect.value, cv = elements.chapterSelect.value;
  if (!bid || !cv) { resetSelect(elements.verseSelect, 'Selecciona un capítulo'); clearPassageDisplay(); return; }
  const cn = Number.parseInt(cv, 10);
  if (!Number.isInteger(cn) || cn <= 0) { resetSelect(elements.verseSelect, 'Capítulo inválido'); return; }
  const book = booksMap.get(bid);
  if (!book) { resetSelect(elements.verseSelect, 'Error de libro'); return; }
  let tv = 0;
  if (Array.isArray(book.verseCounts) && Number.isInteger(Number(book.verseCounts[cn-1]))) tv = Number(book.verseCounts[cn-1]);
  else {
    const dd = await fetchBookDetailData(bid); if (seq !== verseSequence) return;
    if (Array.isArray(dd)) {
      const co = dd.find(c => Number(c.chapter) === cn) || dd[cn-1];
      if (co) { if (Array.isArray(co.verses)) tv = co.verses.length; else if (Number.isInteger(Number(co.versesCount))) tv = Number(co.versesCount); }
    }
  }
  if (tv <= 0) { console.warn('[Biblia App] Sin versículos para ' + book.name + ' cap ' + cn); resetSelect(elements.verseSelect, 'Versículos no disponibles'); return; }
  const d = new Option('-- Versículo --', ''), opts = Array.from({ length: tv }, (_, i) => new Option('Versículo ' + (i+1), String(i+1)));
  elements.verseSelect.replaceChildren(d, ...opts); elements.verseSelect.disabled = false; renderPassage();
}

function clearAutoSaveTimers() { autoSaveTimers.forEach(t => clearTimeout(t)); autoSaveTimers.clear(); }

function clearPassageDisplay() {
  clearAutoSaveTimers();
  if (!elements.passageDisplay) return;
  elements.passageDisplay.classList.add('hidden'); elements.passageDisplay.replaceChildren();
}

function getNoteValue(key) {
  const v = userNotes[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v;
  if (isPlainObject(v) && 'value' in v) return v.value;
  return typeof v === 'string' ? v : '';
}

async function renderPassage() {
  if (!elements.passageDisplay) return;
  const cr = ++renderSequence, bid = elements.bookSelect.value, cv = elements.chapterSelect.value, vv = elements.verseSelect.value;
  if (!bid) { clearPassageDisplay(); return; }
  const book = booksMap.get(bid); if (!book) { clearPassageDisplay(); return; }
  clearAutoSaveTimers();
  const frag = document.createDocumentFragment();
  const bc = document.createElement('div'); bc.className = 'passage-title-group'; bc.style.marginBottom = '0.5rem';
  const tn = book.testament === 'OT' ? 'Antiguo Testamento' : book.testament === 'NT' ? 'Nuevo Testamento' : '';
  if (tn) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = tn; bc.appendChild(b); }
  if (typeof book.category === 'string' && book.category.trim()) { const b = document.createElement('span'); b.className = 'badge muted'; b.style.marginLeft = '0.4rem'; b.textContent = book.category; bc.appendChild(b); }
  frag.appendChild(bc);
  let cd = null;
  if (cv) { const cl = await fetchBookDetailData(bid); if (cr !== renderSequence) return; if (Array.isArray(cl)) cd = cl.find(c => Number(c.chapter) === Number(cv)) || null; }
  const th = document.createElement('div'); th.className = 'passage-header';
  const tg = document.createElement('div'); tg.className = 'passage-title-group';
  const ki = cd?.conceptualSummary?.keyIdea;
  if (typeof ki === 'string' && ki.trim()) { const kb = document.createElement('span'); kb.className = 'badge-accent'; kb.textContent = ki; tg.appendChild(kb); }
  let tt = String(book.name); if (cv) tt += ' ' + cv; if (vv) tt += ':' + vv;
  if (typeof cd?.sectionTitle === 'string' && cd.sectionTitle.trim()) tt += ': ' + cd.sectionTitle;
  const h2 = document.createElement('h2'); h2.textContent = tt; tg.appendChild(h2); th.appendChild(tg);
  const rt = Number(cd?.estimatedReadingTimeMinutes);
  if (Number.isFinite(rt) && rt > 0) { const m = document.createElement('span'); m.className = 'meta-info'; m.textContent = '⏱️ ' + rt + ' min de lectura'; th.appendChild(m); }
  frag.appendChild(th);
  if (cd) renderInteractiveStudyModule(frag, cd, bid);
  else { const p = document.createElement('p'); p.style.color = 'var(--text-muted)'; p.style.marginTop = '0.75rem'; p.textContent = 'Pasaje seleccionado correctamente.'; frag.appendChild(p); }
  if (cr !== renderSequence) return;
  elements.passageDisplay.replaceChildren(frag); elements.passageDisplay.classList.remove('hidden');
}

function renderInteractiveStudyModule(parent, cd, bid) {
  const cid = String(cd.chapter);
  const pSid = 'panel_summary_'+bid+'_'+cid, pQid = 'panel_questions_'+bid+'_'+cid, pEid = 'panel_exercise_'+bid+'_'+cid;

  const nav = document.createElement('nav'); nav.className = 'passage-tabs'; nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', 'Secciones del pasaje');
  function mkTab(pid, label, active) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tab-btn' + (active ? ' active' : '');
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(!!active)); b.setAttribute('aria-controls', pid);
    b.tabIndex = active ? 0 : -1; b.id = 'btn_' + pid; b.textContent = label; return b;
  }
  const tS = mkTab(pSid, '📝 Resumen', true), qc = Array.isArray(cd.criticalAnalysisQuestions) ? cd.criticalAnalysisQuestions.length : 0;
  const tQ = mkTab(pQid, '🤔 Análisis (' + qc + ')'), tE = mkTab(pEid, '🎯 Práctica');
  nav.append(tS, tQ, tE); parent.appendChild(nav);

  // RESUMEN
  const pS = document.createElement('article'); pS.id = pSid; pS.className = 'tab-content'; pS.setAttribute('role', 'tabpanel'); pS.setAttribute('aria-labelledby', tS.id);
  const pTxt = document.createElement('p'); pTxt.className = 'summary-text'; pTxt.textContent = typeof cd?.conceptualSummary?.text === 'string' ? cd.conceptualSummary.text : '';
  const ft = document.createElement('footer'); ft.className = 'summary-footer';
  const wc = Number(cd?.conceptualSummary?.wordCount), sm = document.createElement('small'); sm.className = 'text-muted'; sm.textContent = 'Palabras: ' + (Number.isFinite(wc) ? wc : 0);
  ft.appendChild(sm); pS.append(pTxt, ft); parent.appendChild(pS);

  // ANÁLISIS (PREGUNTAS)
  const pQ = document.createElement('article'); pQ.id = pQid; pQ.className = 'tab-content hidden'; pQ.setAttribute('role', 'tabpanel'); pQ.setAttribute('aria-labelledby', tQ.id);
  const qList = document.createElement('div'); qList.className = 'questions-list';
  const qs = Array.isArray(cd.criticalAnalysisQuestions) ? cd.criticalAnalysisQuestions : [];
  qs.forEach(q => {
    if (!q) return;
    const qid = String(q.id), nk = 'q_'+bid+'_'+cid+'_'+qid;
    const sv = getNoteValue(nk), st = typeof sv === 'string' ? sv : '';
    const card = document.createElement('div'); card.className = 'question-card';
    const qh = document.createElement('div'); qh.className = 'question-header';
    const bf = document.createElement('span'); bf.className = 'badge-focus'; bf.textContent = 'Enfoque: ' + (typeof q.focus === 'string' ? q.focus : 'General'); qh.appendChild(bf);
    const qb = document.createElement('p'); qb.className = 'question-body';
    const sn = document.createElement('strong'); sn.textContent = qid + '. '; qb.append(sn, document.createTextNode(typeof q.question === 'string' ? q.question : ''));
    const tid = 'ta_' + nk;
    const lb = document.createElement('label'); lb.className = 'visually-hidden'; lb.setAttribute('for', tid); lb.textContent = 'Reflexión pregunta ' + qid;
    const ta = document.createElement('textarea'); ta.className = 'form-control question-input'; ta.id = tid; ta.dataset.key = nk;
    ta.maxLength = MAX_NOTE_LENGTH; ta.placeholder = 'Escribe tu reflexión sobre este punto...'; ta.value = st;
    ta.setAttribute('autocomplete', 'off'); ta.setAttribute('spellcheck', 'true');
    const ss = document.createElement('span'); ss.className = 'save-status'; ss.dataset.statusKey = nk; ss.textContent = st ? '✓ Guardado' : 'Listo para guardar';
    card.append(qh, qb, lb, ta, ss); qList.appendChild(card);
  });
  pQ.appendChild(qList); parent.appendChild(pQ);

  // PRÁCTICA
  const pE = document.createElement('article'); pE.id = pEid; pE.className = 'tab-content hidden'; pE.setAttribute('role', 'tabpanel'); pE.setAttribute('aria-labelledby', tE.id);
  const ec = document.createElement('div'); ec.className = 'exercise-card';
  const eh = document.createElement('div'); eh.className = 'exercise-header';
  const h3 = document.createElement('h3'); h3.textContent = 'Objetivo del Ejercicio';
  const sd = document.createElement('span'); sd.className = 'badge-time';
  const dur = Number(cd?.practicalExercise?.suggestedDurationMinutes); sd.textContent = '⌛ ' + (Number.isFinite(dur) && dur > 0 ? dur : 15) + ' min';
  eh.append(h3, sd);
  const po = document.createElement('p'); po.className = 'exercise-objective'; po.textContent = cd?.practicalExercise?.objective || '';
  const h4 = document.createElement('h4'); h4.className = 'section-subtitle'; h4.textContent = 'Pasos de Implementación';
  const ul = document.createElement('ul'); ul.className = 'checklist-group';
  const ins = Array.isArray(cd?.practicalExercise?.instructions) ? cd.practicalExercise.instructions : [];
  ins.forEach((st, i) => {
    const sk = 'step_'+bid+'_'+cid+'_'+i, sv = getNoteValue(sk), ic = sv === true;
    const li = document.createElement('li'); li.className = 'checklist-item';
    const la = document.createElement('label'); la.className = 'checkbox-label';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.key = sk; cb.checked = ic;
    const sp = document.createElement('span'); sp.textContent = typeof st === 'string' ? st : '';
    la.append(cb, sp); li.appendChild(la); ul.appendChild(li);
  });
  const db = document.createElement('div'); db.className = 'deliverable-box';
  const dl = document.createElement('label'); dl.className = 'deliverable-label';
  const di = document.createElement('span'); di.textContent = '📋 '; const ds = document.createElement('strong'); ds.textContent = 'Entregable Generado'; dl.append(di, ds);
  const dd = document.createElement('p'); dd.className = 'deliverable-desc'; dd.textContent = cd?.practicalExercise?.deliverable || '';
  const dk = 'deliv_'+bid+'_'+cid, dv = getNoteValue(dk), dt = typeof dv === 'string' ? dv : '';
  const daid = 'ta_' + dk;
  const dlb = document.createElement('label'); dlb.className = 'visually-hidden'; dlb.setAttribute('for', daid); dlb.textContent = 'Entregable final';
  const da = document.createElement('textarea'); da.className = 'form-control'; da.id = daid; da.dataset.key = dk;
  da.maxLength = MAX_NOTE_LENGTH; da.placeholder = 'Escribe aquí tu plan de acción o entregable final...'; da.value = dt;
  da.setAttribute('autocomplete', 'off'); da.setAttribute('spellcheck', 'true');
  const dss = document.createElement('span'); dss.className = 'save-status'; dss.dataset.statusKey = dk; dss.textContent = dt ? '✓ Guardado' : 'Listo para guardar';
  db.append(dl, dd, dlb, da, dss);
  ec.append(eh, po, h4, ul, db); pE.appendChild(ec); parent.appendChild(pE);
}

function initPassageDisplayDelegation() {
  if (!elements.passageDisplay) return;
  elements.passageDisplay.addEventListener('click', ev => {
    const t = ev.target; if (!(t instanceof Element)) return;
    const tb = t.closest('.tab-btn'); if (!tb) return;
    const tabs = elements.passageDisplay.querySelectorAll('.tab-btn'), panels = elements.passageDisplay.querySelectorAll('.tab-content');
    tabs.forEach(t => { const a = t === tb; t.classList.toggle('active', a); t.setAttribute('aria-selected', String(a)); t.tabIndex = a ? 0 : -1; });
    panels.forEach(p => p.classList.add('hidden'));
    const pid = tb.getAttribute('aria-controls'); if (!pid) return;
    const tp = elements.passageDisplay.querySelector('#' + CSS.escape(pid)); if (tp) tp.classList.remove('hidden');
  });
  elements.passageDisplay.addEventListener('change', ev => {
    const t = ev.target; if (!(t instanceof HTMLInputElement) || t.type !== 'checkbox' || !t.dataset.key) return;
    userNotes[t.dataset.key] = { value: t.checked, _ts: now() }; saveNotesToStorage();
  });
  elements.passageDisplay.addEventListener('input', ev => {
    const t = ev.target; if (!(t instanceof HTMLTextAreaElement) || !t.dataset.key) return;
    const k = t.dataset.key; userNotes[k] = { value: t.value, _ts: now() };
    const se = elements.passageDisplay.querySelector('[data-status-key="' + CSS.escape(k) + '"]');
    if (se) { se.textContent = '⏳ Guardando...'; se.classList.add('visible'); }
    saveNotesToStorage();
    if (autoSaveTimers.has(k)) clearTimeout(autoSaveTimers.get(k));
    const tid = setTimeout(() => { if (se) { se.textContent = '✓ Guardado'; setTimeout(() => se.classList.remove('visible'), 1500); } autoSaveTimers.delete(k); }, 600);
    autoSaveTimers.set(k, tid);
  });
  elements.passageDisplay.addEventListener('keydown', ev => {
    const t = ev.target; if (!(t instanceof HTMLButtonElement) || !t.matches('.tab-btn')) return;
    const tabs = Array.from(elements.passageDisplay.querySelectorAll('.tab-btn')), ci = tabs.indexOf(t); if (ci === -1) return;
    let ni = ci;
    if (ev.key === 'ArrowRight') ni = (ci+1) % tabs.length; else if (ev.key === 'ArrowLeft') ni = (ci-1+tabs.length) % tabs.length;
    else if (ev.key === 'Home') ni = 0; else if (ev.key === 'End') ni = tabs.length - 1; else return;
    ev.preventDefault(); tabs[ni].focus(); tabs[ni].click();
  });
}

function resetSelect(sel, ph) { if (!sel) return; sel.replaceChildren(new Option(ph, '')); sel.disabled = true; }
function setLoadingState() { resetSelect(elements.bookSelect, 'Cargando libros...'); resetSelect(elements.chapterSelect, 'Selecciona un libro'); resetSelect(elements.verseSelect, 'Selecciona un capítulo'); }
function showError(msg, retry) {
  if (!elements.statusBanner) return;
  elements.statusBanner.className = 'status-banner error'; elements.statusBanner.replaceChildren();
  const s = document.createElement('span'); s.textContent = '⚠️ ' + msg; elements.statusBanner.appendChild(s);
  if (typeof retry === 'function') { const b = document.createElement('button'); b.type = 'button'; b.className = 'retry-btn'; b.textContent = 'Reintentar'; b.addEventListener('click', retry, { once: true }); elements.statusBanner.appendChild(b); }
  elements.statusBanner.classList.remove('hidden');
}
function showWarning(msg) {
  if (!elements.statusBanner) return; if (elements.statusBanner.classList.contains('error')) return;
  elements.statusBanner.className = 'status-banner warning'; elements.statusBanner.replaceChildren();
  const s = document.createElement('span'); s.textContent = '💡 ' + msg; elements.statusBanner.appendChild(s);
  elements.statusBanner.classList.remove('hidden');
}
function clearStatus() { if (!elements.statusBanner) return; elements.statusBanner.classList.add('hidden'); elements.statusBanner.replaceChildren(); }

elements.bookSelect.addEventListener('change', updateChapters);
elements.chapterSelect.addEventListener('change', updateVerses);
elements.verseSelect.addEventListener('change', renderPassage);

function exportNotes() {
  try {
    const b = new Blob([JSON.stringify(userNotes, null, 2)], { type: 'application/json' }), u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = 'notas-biblicas-' + new Date().toISOString().slice(0,10) + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(u);
    showWarning('✅ Notas exportadas correctamente.');
  } catch (e) { console.error(e); showError('No se pudieron exportar.', null); }
}
function importNotesFromFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = (e) => {
    try {
      const imp = JSON.parse(e.target.result); if (!isPlainObject(imp)) throw new Error('Inválido');
      const ni = normalizeNotes(imp);
      if (confirm('¿Reemplazar notas actuales?\nAceptar = Reemplazar\nCancelar = Fusionar')) userNotes = ni;
      else { const m = { ...userNotes }; for (const [k,v] of Object.entries(ni)) { const ex = m[k]; if (!ex) m[k] = v; else if (isPlainObject(ex) && isPlainObject(v) && typeof ex._ts === 'number' && typeof v._ts === 'number') m[k] = v._ts >= ex._ts ? v : ex; else m[k] = v; } userNotes = m; }
      safeSaveNotes(userNotes); renderPassage(); showWarning('✅ Notas importadas.');
    } catch (err) { console.error(err); showError('Archivo inválido.', null); }
  };
  r.onerror = () => showError('No se pudo leer el archivo.', null);
  r.readAsText(file);
}
window.BibliaApp = Object.freeze({ exportNotes, importNotesFromFile, version: '1.1.0' });
console.info('[Biblia App] v1.1.0 — Usa BibliaApp.exportNotes() para exportar.');

initScopeFilter();
initPassageDisplayDelegation();
loadManifest();

});
