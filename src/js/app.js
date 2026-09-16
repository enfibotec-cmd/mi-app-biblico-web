'use strict';
document.addEventListener('DOMContentLoaded', () => {
// ==========================================
// 1. VALIDACIÓN DE DEPENDENCIAS DOM
// ==========================================
/** @type {Record<string, HTMLElement|null>} */
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
  console.error('[Biblia App] Faltan elementos críticos del DOM. Verifica la plantilla HTML.');
  return;
}

// ==========================================
// 2. CONFIGURACIÓN
// ==========================================
const STORAGE_KEY = 'bibliaApp_notes';
const THEME_STORAGE_KEY = 'bibliaApp_theme';
const MAX_NOTE_LENGTH = 5000;
const MAX_STORAGE_SIZE = 4 * 1024 * 1024; // 4 MB
const STORAGE_WARNING_THRESHOLD = 0.80; // 80% para alerta preventiva
const FETCH_TIMEOUT_MS = 10000; // [NUEVO] Timeout para peticiones (H-008)

let currentScope = 'ALL';
const booksList = [];
let booksMap = new Map();
const chapterDataCache = new Map();
const autoSaveTimers = new Map();
let userNotes = {};

// Control de renderizado y peticiones para evitar condiciones de carrera.
let renderSequence = 0;
let chapterSequence = 0;
let verseSequence = 0;

// ==========================================
// 3. UTILIDADES
// ==========================================
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function debounce(fn, delay = 350) {
  let timeoutId = null;
  return (...args) => {
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, delay);
  };
}

function getByteSize(text) {
  return new Blob([text]).size;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// [NUEVO] Fetch con timeout para evitar peticiones colgadas (H-008)
function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timeoutId));
}

// [NUEVO] Utilidad para generar timestamp ISO (H-017)
function nowTimestamp() {
  return Date.now();
}

// ==========================================
// 4. LOCAL STORAGE Y SALUD DEL ALMACENAMIENTO
// ==========================================

// [CORREGIDO] (H-013) Ofrece respaldo antes de limpiar notas corruptas
function loadNotesFromStorage() {
  try {
    const storedNotes = localStorage.getItem(STORAGE_KEY);
    if (!storedNotes) return {};
    const parsed = JSON.parse(storedNotes);
    if (!isPlainObject(parsed)) throw new Error('Formato de notas inválido.');
    return parsed;
  } catch (error) {
    console.warn('[Biblia App] Datos locales corruptos.', error);

    // [NUEVO] Ofrecer respaldo antes de eliminar
    const backup = localStorage.getItem(STORAGE_KEY);
    setTimeout(() => {
      if (backup && confirm(
        'Tus notas locales están corruptas. ¿Deseas descargar una copia de respaldo antes de reiniciar?'
      )) {
        try {
          const blob = new Blob([backup], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `respaldo-notas-corruptas-${Date.now()}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (e) {
          console.warn('[Biblia App] No se pudo descargar el respaldo.', e);
        }
      }

      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      showWarning('Tus notas locales estaban corruptas y se han reiniciado de forma segura.');
    }, 500);

    return {};
  }
}

function checkStorageHealth() {
  try {
    const currentSize = getByteSize(JSON.stringify(userNotes));
    const usagePercent = currentSize / MAX_STORAGE_SIZE;
    if (usagePercent >= STORAGE_WARNING_THRESHOLD) {
      showWarning(
        `Almacenamiento local al ${Math.round(usagePercent * 100)}% (${formatBytes(currentSize)} usados). ` +
        'Te recomendamos exportar tus notas pronto para evitar pérdidas.'
      );
    }
  } catch (e) {
    // Ignorar errores de cálculo silenciosamente
  }
}

function safeSaveNotes(notes) {
  try {
    const serialized = JSON.stringify(notes);
    const byteSize = getByteSize(serialized);
    if (byteSize > MAX_STORAGE_SIZE) {
      showError(
        'El almacenamiento local está lleno. Exporta tus notas y limpia el historial para continuar.',
        null
      );
      return false;
    }
    localStorage.setItem(STORAGE_KEY, serialized);
    checkStorageHealth();
    return true;
  } catch (error) {
    console.error('[Biblia App] Error al guardar en LocalStorage:', error);
    showError('No se pudieron guardar tus notas. El almacenamiento puede estar lleno o bloqueado.', null);
    return false;
  }
}

const saveNotesToStorage = debounce(() => {
  safeSaveNotes(userNotes);
}, 500);

userNotes = loadNotesFromStorage();
checkStorageHealth();

// ==========================================
// 5. SINCRONIZACIÓN ENTRE PESTAÑAS
// ==========================================
// [CORREGIDO] (H-017) Fusión con preservación de timestamps para evitar pérdida de datos
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  if (event.newValue === null) {
    userNotes = {};
    renderPassage();
    return;
  }
  try {
    const parsed = JSON.parse(event.newValue);
    if (!isPlainObject(parsed)) throw new Error('Formato de sincronización inválido.');

    // Fusión inteligente: para cada clave, conservar la versión más reciente
    // Si no hay timestamps, prioriza la versión local (comportamiento anterior)
    const merged = { ...parsed };
    for (const [key, localValue] of Object.entries(userNotes)) {
      const remoteValue = parsed[key];
      if (remoteValue === undefined) {
        merged[key] = localValue;
      } else if (
        isPlainObject(localValue) && isPlainObject(remoteValue) &&
        typeof localValue._ts === 'number' && typeof remoteValue._ts === 'number'
      ) {
        merged[key] = localValue._ts >= remoteValue._ts ? localValue : remoteValue;
      }
      // Si no hay timestamps, se conserva la versión remota (parsed) por defecto
    }

    const previousKeysCount = Object.keys(userNotes).length;
    userNotes = merged;
    const newKeysCount = Object.keys(userNotes).length;

    if (newKeysCount !== previousKeysCount || JSON.stringify(userNotes) !== JSON.stringify(parsed)) {
      console.info('[Biblia App] Notas sincronizadas con otra pestaña.');
      renderPassage();
    }
  } catch (error) {
    console.warn('[Biblia App] Datos corruptos durante la sincronización.', error);
  }
});

// ==========================================
// 6. TEMA
// ==========================================
// [CORREGIDO] (H-010) Respeta prefers-color-scheme en la primera visita
function getInitialTheme() {
  // 1. Preferencia explícita del usuario
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {}

  // 2. Preferencia del sistema operativo
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }

  return 'light';
}

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    console.warn('[Biblia App] No se pudo guardar el tema.', error);
  }
}

function updateThemeIcon(theme) {
  if (!elements.themeToggle) return;
  const isDark = theme === 'dark';
  elements.themeToggle.textContent = isDark ? '☀️' : '🌙';
  elements.themeToggle.setAttribute('aria-label', isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  elements.themeToggle.setAttribute('aria-pressed', String(isDark));
}

const savedTheme = getInitialTheme();
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeIcon(savedTheme);

elements.themeToggle?.addEventListener('click', () => {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  saveTheme(newTheme);
  updateThemeIcon(newTheme);
});

// [NUEVO] Escuchar cambios en preferencia del sistema (H-010)
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    try {
      // Solo aplicar si el usuario no ha elegido manualmente
      if (!localStorage.getItem(THEME_STORAGE_KEY)) {
        const newTheme = e.matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        updateThemeIcon(newTheme);
      }
    } catch {}
  });
}

// ==========================================
// 7. CARGA DEL MANIFEST
// ==========================================
// [CORREGIDO] (H-008) Usa fetchWithTimeout
async function loadManifest() {
  setLoadingState();
  try {
    const response = await fetchWithTimeout('./data/manifest.json', {
      cache: 'default',
      headers: { Accept: 'application/json' }
    }, FETCH_TIMEOUT_MS);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('La respuesta del servidor no es JSON.');

    const data = await response.json();
    let rawBooks = [];

    if (Array.isArray(data.books)) {
      rawBooks = data.books;
    } else if (isPlainObject(data.books)) {
      rawBooks = Object.entries(data.books)
        .map(([key, value]) => isPlainObject(value) ? { ...value, code: value.code || key, id: value.id || key } : null)
        .filter(Boolean);
    }

    if (!rawBooks.length) throw new Error('El manifest no contiene libros válidos.');

    const validBooks = rawBooks.filter(book =>
      isPlainObject(book) && (book.code || book.id) && typeof book.name === 'string'
    );
    if (!validBooks.length) throw new Error('No se encontraron libros válidos en el manifest.');

    booksMap = new Map();
    validBooks.forEach(book => {
      const code = String(book.code || book.id);
      booksMap.set(code, book);
    });

    booksList.length = 0;
    booksList.push(...booksMap.values());

    updateBadgeCounts();
    clearStatus();
    populateBooks();
  } catch (error) {
    console.error('[Biblia App] Error al cargar manifest:', error);
    if (error.name === 'AbortError') {
      showError('La conexión tardó demasiado. Verifica tu conexión e intenta de nuevo.', loadManifest);
    } else {
      showError('Error al cargar la lista de libros. Revisa la conexión o la ruta de manifest.json.', loadManifest);
    }
  }
}

// ==========================================
// 8. CARGA Y CACHÉ DE LIBROS
// ==========================================
// [CORREGIDO] (H-008) Usa fetchWithTimeout
async function fetchBookDetailData(bookId) {
  if (!bookId) return null;
  const key = String(bookId).toLowerCase();
  if (chapterDataCache.has(key)) return chapterDataCache.get(key);

  try {
    const response = await fetchWithTimeout(
      `./data/biblia/${encodeURIComponent(key)}.json`,
      { cache: 'default', headers: { Accept: 'application/json' } },
      FETCH_TIMEOUT_MS
    );

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('La respuesta del libro no es JSON.');

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('La estructura del libro no es válida.');

    chapterDataCache.set(key, data);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn(`[Biblia App] Timeout al cargar ${bookId}`);
    } else {
      console.warn(`[Biblia App] No se pudo cargar ${bookId}:`, error);
    }
    return null;
  }
}

// ==========================================
// 9. CONTADORES
// ==========================================
function updateBadgeCounts() {
  const otCount = booksList.filter(book => book.testament === 'OT').length;
  const ntCount = booksList.filter(book => book.testament === 'NT').length;
  if (elements.badgeAll) elements.badgeAll.textContent = String(booksList.length);
  if (elements.badgeOT) elements.badgeOT.textContent = String(otCount);
  if (elements.badgeNT) elements.badgeNT.textContent = String(ntCount);
}

// ==========================================
// 10. FILTRO
// ==========================================
function initScopeFilter() {
  if (!elements.scopeFilter) return;
  elements.scopeFilter.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('.scope-btn');
    if (!button || !button.dataset.scope) return;

    const selectedScope = button.dataset.scope;
    if (selectedScope === currentScope) return;

    currentScope = selectedScope;
    const buttons = elements.scopeFilter.querySelectorAll('.scope-btn');
    buttons.forEach(btn => {
      const active = btn.dataset.scope === currentScope;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    populateBooks();
  });
}

// ==========================================
// 11. SELECTOR DE LIBROS
// ==========================================
function populateBooks() {
  elements.bookSelect.replaceChildren(new Option('-- Seleccionar Libro --', ''));
  const filteredBooks = booksList.filter(book => currentScope === 'ALL' || book.testament === currentScope);

  if (currentScope === 'ALL') {
    const groupOT = document.createElement('optgroup');
    groupOT.label = '— Antiguo Testamento —';
    const groupNT = document.createElement('optgroup');
    groupNT.label = '— Nuevo Testamento —';

    filteredBooks.forEach(book => {
      const bookCode = String(book.code || book.id);
      const option = new Option(book.name, bookCode);
      if (book.testament === 'OT') groupOT.appendChild(option);
      else if (book.testament === 'NT') groupNT.appendChild(option);
      else elements.bookSelect.appendChild(option);
    });

    if (groupOT.children.length) elements.bookSelect.appendChild(groupOT);
    if (groupNT.children.length) elements.bookSelect.appendChild(groupNT);
  } else {
    filteredBooks.forEach(book => {
      elements.bookSelect.appendChild(new Option(book.name, String(book.code || book.id)));
    });
  }

  elements.bookSelect.disabled = filteredBooks.length === 0;
  resetSelect(elements.chapterSelect, 'Selecciona un libro');
  resetSelect(elements.verseSelect, 'Selecciona un capítulo');
  clearPassageDisplay();
}

// ==========================================
// 12. CAPÍTULOS (CON CONTROL ASÍNCRONO)
// ==========================================
async function updateChapters() {
  const currentSeq = ++chapterSequence;
  const selectedBookId = elements.bookSelect.value;

  if (!selectedBookId) {
    resetSelect(elements.chapterSelect, 'Selecciona un libro');
    resetSelect(elements.verseSelect, 'Selecciona un capítulo');
    clearPassageDisplay();
    return;
  }

  const book = booksMap.get(selectedBookId);
  let totalChapters = Number(book?.chapters || book?.chapterCount || 0);

  if (totalChapters <= 0) {
    const chaptersList = await fetchBookDetailData(selectedBookId);
    if (currentSeq !== chapterSequence) return;
    if (Array.isArray(chaptersList)) totalChapters = chaptersList.length;
  }

  if (totalChapters <= 0) {
    resetSelect(elements.chapterSelect, 'Sin capítulos');
    resetSelect(elements.verseSelect, 'Sin versículos');
    return;
  }

  const defaultOption = new Option('-- Capítulo --', '');
  const options = Array.from({ length: totalChapters }, (_, index) => new Option(`Capítulo ${index + 1}`, String(index + 1)));
  elements.chapterSelect.replaceChildren(defaultOption, ...options);
  elements.chapterSelect.disabled = false;
  resetSelect(elements.verseSelect, 'Selecciona un capítulo');
  clearPassageDisplay();
}

// ==========================================
// 13. VERSÍCULOS (CON CONTROL ASÍNCRONO)
// ==========================================
async function updateVerses() {
  const currentSeq = ++verseSequence;
  const selectedBookId = elements.bookSelect.value;
  const chapterValue = elements.chapterSelect.value;

  if (!selectedBookId || !chapterValue) {
    resetSelect(elements.verseSelect, 'Selecciona un capítulo');
    clearPassageDisplay();
    return;
  }

  const chapterNum = Number.parseInt(chapterValue, 10);
  if (!Number.isInteger(chapterNum) || chapterNum <= 0) {
    resetSelect(elements.verseSelect, 'Capítulo inválido');
    return;
  }

  const book = booksMap.get(selectedBookId);
  if (!book) {
    resetSelect(elements.verseSelect, 'Error de libro');
    return;
  }

  const chapterIndex = chapterNum - 1;
  let totalVerses = 0;

  if (Array.isArray(book.verseCounts) && Number.isInteger(Number(book.verseCounts[chapterIndex]))) {
    totalVerses = Number(book.verseCounts[chapterIndex]);
  } else {
    const detailData = await fetchBookDetailData(selectedBookId);
    if (currentSeq !== verseSequence) return;
    if (Array.isArray(detailData)) {
      const chapterObj = detailData.find(chapter => Number(chapter.chapter) === chapterNum) || detailData[chapterIndex];
      if (chapterObj) {
        if (Array.isArray(chapterObj.verses)) {
          totalVerses = chapterObj.verses.length;
        } else if (Number.isInteger(Number(chapterObj.versesCount))) {
          totalVerses = Number(chapterObj.versesCount);
        }
      }
    }
  }

  if (totalVerses <= 0) {
    console.warn(`[Biblia App] No se pudo determinar la cantidad de versículos de ${book.name}, capítulo ${chapterNum}.`);
    resetSelect(elements.verseSelect, 'Versículos no disponibles');
    return;
  }

  const defaultOption = new Option('-- Versículo --', '');
  const options = Array.from({ length: totalVerses }, (_, index) => new Option(`Versículo ${index + 1}`, String(index + 1)));
  elements.verseSelect.replaceChildren(defaultOption, ...options);
  elements.verseSelect.disabled = false;
  renderPassage();
}

// ==========================================
// 14. LIMPIEZA DE TIMERS
// ==========================================
function clearAutoSaveTimers() {
  autoSaveTimers.forEach(timerId => clearTimeout(timerId));
  autoSaveTimers.clear();
}

// ==========================================
// 15. PASAJE
// ==========================================
function clearPassageDisplay() {
  clearAutoSaveTimers();
  if (!elements.passageDisplay) return;
  elements.passageDisplay.classList.add('hidden');
  elements.passageDisplay.replaceChildren();
}

async function renderPassage() {
  if (!elements.passageDisplay) return;
  const currentRender = ++renderSequence;

  const bookId = elements.bookSelect.value;
  const chapterValue = elements.chapterSelect.value;
  const verseValue = elements.verseSelect.value;

  if (!bookId) {
    clearPassageDisplay();
    return;
  }

  const book = booksMap.get(bookId);
  if (!book) {
    clearPassageDisplay();
    return;
  }

  clearAutoSaveTimers();

  const fragment = document.createDocumentFragment();

  // Badges
  const badgeContainer = document.createElement('div');
  badgeContainer.className = 'passage-title-group';
  badgeContainer.style.marginBottom = '0.5rem';

  const testamentName = book.testament === 'OT' ? 'Antiguo Testamento' : book.testament === 'NT' ? 'Nuevo Testamento' : '';
  if (testamentName) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = testamentName;
    badgeContainer.appendChild(badge);
  }

  if (typeof book.category === 'string' && book.category.trim()) {
    const badge = document.createElement('span');
    badge.className = 'badge muted';
    badge.style.marginLeft = '0.4rem';
    badge.textContent = book.category;
    badgeContainer.appendChild(badge);
  }

  fragment.appendChild(badgeContainer);

  // Cargar detalle del capítulo
  let chapterDetail = null;
  if (chapterValue) {
    const chaptersList = await fetchBookDetailData(bookId);
    if (currentRender !== renderSequence) return;
    if (Array.isArray(chaptersList)) {
      chapterDetail = chaptersList.find(chapter => Number(chapter.chapter) === Number(chapterValue)) || null;
    }
  }

  // Encabezado
  const titleHeader = document.createElement('div');
  titleHeader.className = 'passage-header';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'passage-title-group';

  const keyIdea = chapterDetail?.conceptualSummary?.keyIdea;
  if (typeof keyIdea === 'string' && keyIdea.trim()) {
    const keyBadge = document.createElement('span');
    keyBadge.className = 'badge-accent';
    keyBadge.textContent = keyIdea;
    titleGroup.appendChild(keyBadge);
  }

  let titleText = String(book.name);
  if (chapterValue) titleText += ` ${chapterValue}`;
  if (verseValue) titleText += `:${verseValue}`;
  if (typeof chapterDetail?.sectionTitle === 'string' && chapterDetail.sectionTitle.trim()) {
    titleText += `: ${chapterDetail.sectionTitle}`;
  }

  const titleEl = document.createElement('h2');
  titleEl.textContent = titleText;
  titleGroup.appendChild(titleEl);
  titleHeader.appendChild(titleGroup);

  const readingTime = Number(chapterDetail?.estimatedReadingTimeMinutes);
  if (Number.isFinite(readingTime) && readingTime > 0) {
    const timeMeta = document.createElement('span');
    timeMeta.className = 'meta-info';
    timeMeta.textContent = `⏱️ ${readingTime} min de lectura`;
    titleHeader.appendChild(timeMeta);
  }

  fragment.appendChild(titleHeader);

  // Contenido
  if (chapterDetail) {
    renderInteractiveStudyModule(fragment, chapterDetail, bookId);
  } else {
    const infoEl = document.createElement('p');
    infoEl.style.color = 'var(--text-muted)';
    infoEl.style.marginTop = '0.75rem';
    infoEl.textContent = 'Pasaje seleccionado correctamente.';
    fragment.appendChild(infoEl);
  }

  if (currentRender !== renderSequence) return;
  elements.passageDisplay.replaceChildren(fragment);
  elements.passageDisplay.classList.remove('hidden');
}

// ==========================================
// 16. MÓDULO DE ESTUDIO
// ==========================================
function renderInteractiveStudyModule(parentFragment, chapterData, bookId) {
  const chapterId = String(chapterData.chapter);
  const panelSummaryId = `panel_summary_${bookId}_${chapterId}`;
  const panelQuestionsId = `panel_questions_${bookId}_${chapterId}`;
  const panelExerciseId = `panel_exercise_${bookId}_${chapterId}`;

  // Tabs
  const navTabs = document.createElement('nav');
  navTabs.className = 'passage-tabs';
  navTabs.setAttribute('role', 'tablist');
  navTabs.setAttribute('aria-label', 'Secciones del pasaje');

  const createTab = (targetPanelId, label, active = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tab-btn${active ? ' active' : ''}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(active));
    button.setAttribute('aria-controls', targetPanelId);
    button.tabIndex = active ? 0 : -1;
    button.id = `btn_${targetPanelId}`;
    button.textContent = label;
    return button;
  };

  const tabSummary = createTab(panelSummaryId, '📝 Resumen', true);
  const questionCount = Array.isArray(chapterData.criticalAnalysisQuestions) ? chapterData.criticalAnalysisQuestions.length : 0;
  const tabQuestions = createTab(panelQuestionsId, `🤔 Análisis (${questionCount})`);
  const tabExercise = createTab(panelExerciseId, '🎯 Práctica');

  navTabs.append(tabSummary, tabQuestions, tabExercise);
  parentFragment.appendChild(navTabs);

  // Panel Resumen
  const panelSummary = document.createElement('article');
  panelSummary.id = panelSummaryId;
  panelSummary.className = 'tab-content';
  panelSummary.setAttribute('role', 'tabpanel');
  panelSummary.setAttribute('aria-labelledby', tabSummary.id);

  const summaryText = chapterData?.conceptualSummary?.text;
  const pSummary = document.createElement('p');
  pSummary.className = 'summary-text';
  pSummary.textContent = typeof summaryText === 'string' ? summaryText : '';

  const footer = document.createElement('footer');
  footer.className = 'summary-footer';
  const wordCount = Number(chapterData?.conceptualSummary?.wordCount);
  const smallCount = document.createElement('small');
  smallCount.className = 'text-muted';
  smallCount.textContent = `Palabras: ${Number.isFinite(wordCount) ? wordCount : 0}`;
  footer.appendChild(smallCount);

  panelSummary.append(pSummary, footer);
  parentFragment.appendChild(panelSummary);

  // Panel Preguntas
  const panelQuestions = document.createElement('article');
  panelQuestions.id = panelQuestionsId;
  panelQuestions.className = 'tab-content hidden';
  panelQuestions.setAttribute('role', 'tabpanel');
  panelQuestions.setAttribute('aria-labelledby', tabQuestions.id);

  const questionsList = document.createElement('div');
  questionsList.className = 'questions-list';

  const questions = Array.isArray(chapterData.criticalAnalysisQuestions) ? chapterData.criticalAnalysisQuestions : [];
  questions.forEach(question => {
    if (!question) return;
    const questionId = String(question.id);
    const noteKey = `q_${bookId}_${chapterId}_${questionId}`;
    const savedEntry = userNotes[noteKey];
    const savedText = typeof savedEntry === 'string' ? savedEntry
                    : (isPlainObject(savedEntry) && typeof savedEntry.value === 'string') ? savedEntry.value
                    : '';

    const card = document.createElement('div');
    card.className = 'question-card';

    const qHeader = document.createElement('div');
    qHeader.className = 'question-header';
    const badgeFocus = document.createElement('span');
    badgeFocus.className = 'badge-focus';
    badgeFocus.textContent = `Enfoque: ${typeof question.focus === 'string' ? question.focus : 'General'}`;
    qHeader.appendChild(badgeFocus);

    const qBody = document.createElement('p');
    qBody.className = 'question-body';
    const strongNum = document.createElement('strong');
    strongNum.textContent = `${questionId}. `;
    qBody.append(strongNum, document.createTextNode(typeof question.question === 'string' ? question.question : ''));

    // [CORREGIDO] (H-017) Añadir label accesible al textarea
    const textareaId = `textarea_${noteKey}`;
    const labelEl = document.createElement('label');
    labelEl.className = 'visually-hidden';
    labelEl.setAttribute('for', textareaId);
    labelEl.textContent = `Reflexión para la pregunta ${questionId}`;

    const textarea = document.createElement('textarea');
    textarea.className = 'form-control question-input';
    textarea.id = textareaId;
    textarea.dataset.key = noteKey;
    textarea.dataset.type = 'note'; // [NUEVO] marca para guardar con timestamp
    textarea.maxLength = MAX_NOTE_LENGTH;
    textarea.placeholder = 'Escribe tu reflexión sobre este punto...';
    textarea.value = savedText;
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('spellcheck', 'true');

    const saveStatus = document.createElement('span');
    saveStatus.className = 'save-status';
    saveStatus.dataset.statusKey = noteKey;
    saveStatus.textContent = savedText ? '✓ Guardado' : 'Listo para guardar';

    card.append(qHeader, qBody, labelEl, textarea, saveStatus);
    questionsList.appendChild(card);
  });

  panelQuestions.appendChild(questionsList);
  parentFragment.appendChild(panelQuestions);

  // Panel Ejercicio
  const panelExercise = document.createElement('article');
  panelExercise.id = panelExerciseId;
  panelExercise.className = 'tab-content hidden';
  panelExercise.setAttribute('role', 'tabpanel');
  panelExercise.setAttribute('aria-labelledby', tabExercise.id);

  const exerciseCard = document.createElement('div');
  exerciseCard.className = 'exercise-card';

  const exHeader = document.createElement('div');
  exHeader.className = 'exercise-header';
  const h3Ex = document.createElement('h3');
  h3Ex.textContent = 'Objetivo del Ejercicio';
  const spanDuration = document.createElement('span');
  spanDuration.className = 'badge-time';
  const duration = Number(chapterData?.practicalExercise?.suggestedDurationMinutes);
  spanDuration.textContent = `⌛ ${Number.isFinite(duration) && duration > 0 ? duration : 15} min`;
  exHeader.append(h3Ex, spanDuration);

  const pObj = document.createElement('p');
  pObj.className = 'exercise-objective';
  pObj.textContent = chapterData?.practicalExercise?.objective || '';

  const h4Steps = document.createElement('h4');
  h4Steps.className = 'section-subtitle';
  h4Steps.textContent = 'Pasos de Implementación';

  const ulSteps = document.createElement('ul');
  ulSteps.className = 'checklist-group';

  const instructions = Array.isArray(chapterData?.practicalExercise?.instructions) ? chapterData.practicalExercise.instructions : [];
  instructions.forEach((stepText, index) => {
    const stepKey = `step_${bookId}_${chapterId}_${index}`;
    const savedEntry = userNotes[stepKey];
    const isChecked = savedEntry === true || (isPlainObject(savedEntry) && savedEntry.value === true);

    const li = document.createElement('li');
    li.className = 'checklist-item';

    const label = document.createElement('label');
    label.className = 'checkbox-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.key = stepKey;
    checkbox.dataset.type = 'check'; // [NUEVO] marca para guardar con timestamp
    checkbox.checked = isChecked;

    const spanText = document.createElement('span');
    spanText.textContent = typeof stepText === 'string' ? stepText : '';

    label.append(checkbox, spanText);
    li.appendChild(label);
    ulSteps.appendChild(li);
  });

  // Entregable
  const deliverableBox = document.createElement('div');
  deliverableBox.className = 'deliverable-box';

  const deliverableLabel = document.createElement('label');
  deliverableLabel.className = 'deliverable-label';
  const iconSpan = document.createElement('span');
  iconSpan.textContent = '📋 ';
  const strongText = document.createElement('strong');
  strongText.textContent = 'Entregable Generado';
  deliverableLabel.append(iconSpan, strongText);

  const deliverableDesc = document.createElement('p');
  deliverableDesc.className = 'deliverable-desc';
  deliverableDesc.textContent = chapterData?.practicalExercise?.deliverable || '';

  const deliverableKey = `deliv_${bookId}_${chapterId}`;
  const savedDelivEntry = userNotes[deliverableKey];
  const savedDelivText = typeof savedDelivEntry === 'string' ? savedDelivEntry
                       : (isPlainObject(savedDelivEntry) && typeof savedDelivEntry.value === 'string') ? savedDelivEntry.value
                       : '';

  const deliverableId = `textarea_${deliverableKey}`;
  const deliverableLabelFor = document.createElement('label');
  deliverableLabelFor.className = 'visually-hidden';
  deliverableLabelFor.setAttribute('for', deliverableId);
  deliverableLabelFor.textContent = 'Entregable final';

  const deliverableArea = document.createElement('textarea');
  deliverableArea.className = 'form-control';
  deliverableArea.id = deliverableId;
  deliverableArea.dataset.key = deliverableKey;
  deliverableArea.dataset.type = 'note'; // [NUEVO]
  deliverableArea.maxLength = MAX_NOTE_LENGTH;
  deliverableArea.placeholder = 'Escribe aquí tu plan de acción o entregable final...';
  deliverableArea.value = savedDelivText;
  deliverableArea.setAttribute('autocomplete', 'off');
  deliverableArea.setAttribute('spellcheck', 'true');

  const deliverableStatus = document.createElement('span');
  deliverableStatus.className = 'save-status';
  deliverableStatus.dataset.statusKey = deliverableKey;
  deliverableStatus.textContent = deliverableArea.value ? '✓ Guardado' : 'Listo para guardar';

  deliverableBox.append(deliverableLabel, deliverableDesc, deliverableLabelFor, deliverableArea, deliverableStatus);
  exerciseCard.append(exHeader, pObj, h4Steps, ulSteps, deliverableBox);
  panelExercise.appendChild(exerciseCard);
  parentFragment.appendChild(panelExercise);
}

// ==========================================
// 17. DELEGACIÓN DE EVENTOS
// ==========================================
function initPassageDisplayDelegation() {
  if (!elements.passageDisplay) return;

  // Tabs
  elements.passageDisplay.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tabButton = target.closest('.tab-btn');
    if (!tabButton) return;

    const tabs = elements.passageDisplay.querySelectorAll('.tab-btn');
    const panels = elements.passageDisplay.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
      const active = tab === tabButton;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });

    panels.forEach(panel => panel.classList.add('hidden'));

    const panelId = tabButton.getAttribute('aria-controls');
    if (!panelId) return;
    const targetPanel = elements.passageDisplay.querySelector(`#${CSS.escape(panelId)}`);
    if (targetPanel) targetPanel.classList.remove('hidden');
  });

  // Checkboxes
  // [CORREGIDO] (H-017) Guarda con timestamp
  elements.passageDisplay.addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox' || !target.dataset.key) return;
    userNotes[target.dataset.key] = { value: target.checked, _ts: nowTimestamp() };
    saveNotesToStorage();
  });

  // Textareas
  // [CORREGIDO] (H-017) Guarda con timestamp
  elements.passageDisplay.addEventListener('input', event => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || !target.dataset.key) return;
    const key = target.dataset.key;
    userNotes[key] = { value: target.value, _ts: nowTimestamp() };

    const statusEl = elements.passageDisplay.querySelector(`[data-status-key="${CSS.escape(key)}"]`);
    if (statusEl) {
      statusEl.textContent = '⏳ Guardando...';
      statusEl.classList.add('visible');
    }

    saveNotesToStorage();

    if (autoSaveTimers.has(key)) clearTimeout(autoSaveTimers.get(key));
    const timerId = setTimeout(() => {
      if (statusEl) {
        statusEl.textContent = '✓ Guardado';
        setTimeout(() => statusEl.classList.remove('visible'), 1500);
      }
      autoSaveTimers.delete(key);
    }, 600);
    autoSaveTimers.set(key, timerId);
  });

  // Navegación de tabs con teclado
  elements.passageDisplay.addEventListener('keydown', event => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.matches('.tab-btn')) return;

    const tabs = Array.from(elements.passageDisplay.querySelectorAll('.tab-btn'));
    const currentIndex = tabs.indexOf(target);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    nextTab.focus();
    nextTab.click();
  });
}

// ==========================================
// 18. ESTADOS Y MENSAJES
// ==========================================
function resetSelect(selectElement, placeholder) {
  if (!selectElement) return;
  selectElement.replaceChildren(new Option(placeholder, ''));
  selectElement.disabled = true;
}

function setLoadingState() {
  resetSelect(elements.bookSelect, 'Cargando libros...');
  resetSelect(elements.chapterSelect, 'Selecciona un libro');
  resetSelect(elements.verseSelect, 'Selecciona un capítulo');
}

function showError(message, retryFn) {
  if (!elements.statusBanner) return;
  elements.statusBanner.className = 'status-banner error';
  elements.statusBanner.replaceChildren();

  const errorSpan = document.createElement('span');
  errorSpan.textContent = `⚠️ ${message}`;
  elements.statusBanner.appendChild(errorSpan);

  if (typeof retryFn === 'function') {
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'retry-btn';
    retryButton.textContent = 'Reintentar';
    retryButton.addEventListener('click', retryFn, { once: true });
    elements.statusBanner.appendChild(retryButton);
  }

  elements.statusBanner.classList.remove('hidden');
}

function showWarning(message) {
  if (!elements.statusBanner) return;
  if (elements.statusBanner.classList.contains('error')) return;

  elements.statusBanner.className = 'status-banner warning';
  elements.statusBanner.replaceChildren();

  const warningSpan = document.createElement('span');
  warningSpan.textContent = `💡 ${message}`;
  elements.statusBanner.appendChild(warningSpan);

  elements.statusBanner.classList.remove('hidden');
}

function clearStatus() {
  if (!elements.statusBanner) return;
  elements.statusBanner.classList.add('hidden');
  elements.statusBanner.replaceChildren();
}

// ==========================================
// 19. EVENTOS PRINCIPALES
// ==========================================
elements.bookSelect.addEventListener('change', updateChapters);
elements.chapterSelect.addEventListener('change', updateVerses);
elements.verseSelect.addEventListener('change', renderPassage);

// ==========================================
// 20. EXPORTACIÓN E IMPORTACIÓN DE NOTAS [NUEVO] (H-011)
// ==========================================
// Normaliza notas antiguas (string/boolean) al nuevo formato con timestamp
function normalizeUserNotes(notes) {
  const normalized = {};
  for (const [key, val] of Object.entries(notes)) {
    if (typeof val === 'string') {
      normalized[key] = { value: val, _ts: nowTimestamp() };
    } else if (typeof val === 'boolean') {
      normalized[key] = { value: val, _ts: nowTimestamp() };
    } else if (isPlainObject(val) && 'value' in val) {
      normalized[key] = { ...val, _ts: typeof val._ts === 'number' ? val._ts : nowTimestamp() };
    }
  }
  return normalized;
}

// Migración automática al iniciar (compatibilidad con notas antiguas)
userNotes = normalizeUserNotes(userNotes);
safeSaveNotes(userNotes);

function exportNotes() {
  try {
    const data = JSON.stringify(userNotes, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notas-biblicas-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showWarning('✅ Notas exportadas correctamente.');
  } catch (error) {
    console.error('[Biblia App] Error al exportar:', error);
    showError('No se pudieron exportar las notas.', null);
  }
}

function importNotesFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!isPlainObject(imported)) throw new Error('Formato inválido');

      const normalizedImport = normalizeUserNotes(imported);
      const action = confirm(
        '¿Deseas REEMPLAZAR tus notas actuales?\n\n' +
        'Aceptar = Reemplazar todo\n' +
        'Cancelar = Fusionar con las actuales'
      );

      if (action) {
        userNotes = normalizedImport;
      } else {
        // Fusión: gana el más reciente por timestamp
        const merged = { ...userNotes };
        for (const [key, val] of Object.entries(normalizedImport)) {
          const existing = merged[key];
          if (!existing) {
            merged[key] = val;
          } else if (
            isPlainObject(existing) && isPlainObject(val) &&
            typeof existing._ts === 'number' && typeof val._ts === 'number'
          ) {
            merged[key] = val._ts >= existing._ts ? val : existing;
          } else {
            merged[key] = val;
          }
        }
        userNotes = merged;
      }

      safeSaveNotes(userNotes);
      renderPassage();
      showWarning('✅ Notas importadas correctamente.');
    } catch (error) {
      console.error('[Biblia App] Error al importar:', error);
      showError('Archivo de notas inválido. Asegúrate de usar un JSON exportado previamente.', null);
    }
  };
  reader.onerror = () => showError('No se pudo leer el archivo.', null);
  reader.readAsText(file);
}

// Exponer API pública para uso desde consola o botones futuros
window.BibliaApp = Object.freeze({
  exportNotes,
  importNotesFromFile,
  version: '1.1.0'
});

console.info('[Biblia App] v1.1.0 — Usa window.BibliaApp.exportNotes() para exportar tus notas.');

// ==========================================
// 21. INICIALIZACIÓN
// ==========================================
initScopeFilter();
initPassageDisplayDelegation();
loadManifest();
});
