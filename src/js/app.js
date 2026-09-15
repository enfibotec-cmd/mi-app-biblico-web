
'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // ==========================================
  // 1. VALIDACIÓN DE DEPENDENCIAS DOM
  // ==========================================
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

  // Estado Global e Índices de Memoria
  let booksList = [];
  let booksMap = new Map(); // Búsqueda O(1) de libros
  const chapterDataCache = new Map(); // Caché O(1) en memoria para JSON de libros (ej. jhn.json)
  const userNotes = JSON.parse(localStorage.getItem('biblico_notes') || '{}');
  let currentScope = 'ALL';
  const DEFAULT_VERSE_FALLBACK = 50;

  // ==========================================
  // 2. UTILIDADES DE RENDIMIENTO (Debounce & Storage)
  // ==========================================
  function debounce(fn, delay = 350) {
    let timeoutId;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delay);
    };
  }

  const saveNotesToStorage = debounce(() => {
    localStorage.setItem('biblico_notes', JSON.stringify(userNotes));
  }, 400);

  // ==========================================
  // 3. GESTIÓN DE MODO OSCURO (Con soporte A11y)
  // ==========================================
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);

  elements.themeToggle?.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);
  });

  function updateThemeIcon(theme) {
    if (!elements.themeToggle) return;
    const isDark = theme === 'dark';

    elements.themeToggle.textContent = isDark ? '☀️' : '🌙';
    elements.themeToggle.setAttribute('aria-label', isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
    elements.themeToggle.setAttribute('aria-pressed', isDark ? 'true' : 'false');
  }

  // ==========================================
  // 4. CARGA Y CACHÉ DE DATOS BÍBLICOS
  // ==========================================
  async function loadManifest() {
    setLoadingState();

    try {
      const response = await fetch(`./data/manifest.json?v=${Date.now()}`, { 
        cache: 'no-store' 
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      let rawBooks = [];
      if (Array.isArray(data.books)) {
        rawBooks = data.books;
      } else if (typeof data.books === 'object' && data.books !== null) {
        rawBooks = Object.entries(data.books).map(([key, value]) => ({
          code: key,
          ...value,
          id: key // Garantiza que 'MAT', 'JHN' no sean sobrescritos por el "id": 40 interno
        }));
      }

      if (!rawBooks.length) throw new Error('El manifest no contiene libros válidos.');

      booksMap = new Map(rawBooks.map(b => [b.code || String(b.id), b]));
      booksList = Array.from(booksMap.values());

      updateBadgeCounts();
      clearStatus();
      populateBooks();

    } catch (error) {
      console.error('[Biblia App] Error al cargar manifest:', error);
      showError('Error al cargar la lista de libros. Revisa la ruta de manifest.json.', loadManifest);
    }
  }

  // Obtención optimizada con caché para JSONs detallados (ej: data/biblia/jhn.json)
  async function fetchBookDetailData(bookId) {
    if (!bookId) return null;
    const key = String(bookId).toLowerCase();

    if (chapterDataCache.has(key)) {
      return chapterDataCache.get(key);
    }

    try {
      const response = await fetch(`./data/biblia/${key}.json`);
      if (!response.ok) return null;

      const data = await response.json();
      chapterDataCache.set(key, data);
      return data;
    } catch {
      return null;
    }
  }

  function updateBadgeCounts() {
    const otCount = booksList.filter(b => b.testament === 'OT').length;
    const ntCount = booksList.filter(b => b.testament === 'NT').length;

    if (elements.badgeAll) elements.badgeAll.textContent = booksList.length;
    if (elements.badgeOT) elements.badgeOT.textContent = otCount;
    if (elements.badgeNT) elements.badgeNT.textContent = ntCount;
  }

  // ==========================================
  // 5. CONTROLADOR DEL FILTRO DE ÁMBITO
  // ==========================================
  function initScopeFilter() {
    if (!elements.scopeFilter) return;

    elements.scopeFilter.addEventListener('click', (e) => {
      const btn = e.target.closest('.scope-btn');
      if (!btn || !btn.dataset.scope) return;

      const selectedScope = btn.dataset.scope;
      if (selectedScope === currentScope) return;

      currentScope = selectedScope;

      const scopeBtns = elements.scopeFilter.querySelectorAll('.scope-btn');
      scopeBtns.forEach(b => {
        const isActive = b.dataset.scope === currentScope;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });

      populateBooks();
    });
  }

  // ==========================================
  // 6. POBLADO Y ACTUALIZACIÓN DE SELECTORES
  // ==========================================
  function populateBooks() {
    elements.bookSelect.replaceChildren(new Option('-- Seleccionar Libro --', ''));

    const filteredBooks = booksList.filter(b => {
      if (currentScope === 'ALL') return true;
      return b.testament === currentScope;
    });

    if (currentScope === 'ALL') {
      const groupOT = document.createElement('optgroup');
      groupOT.label = '— Antiguo Testamento —';
      const groupNT = document.createElement('optgroup');
      groupNT.label = '— Nuevo Testamento —';

      filteredBooks.forEach(b => {
        const bookCode = b.code || String(b.id);
        const option = new Option(b.name, bookCode);
        if (b.testament === 'OT') groupOT.appendChild(option);
        else if (b.testament === 'NT') groupNT.appendChild(option);
        else elements.bookSelect.appendChild(option);
      });

      if (groupOT.children.length > 0) elements.bookSelect.appendChild(groupOT);
      if (groupNT.children.length > 0) elements.bookSelect.appendChild(groupNT);
    } else {
      filteredBooks.forEach(b => {
        const bookCode = b.code || String(b.id);
        elements.bookSelect.appendChild(new Option(b.name, bookCode));
      });
    }

    elements.bookSelect.disabled = filteredBooks.length === 0;

    resetSelect(elements.chapterSelect, 'Selecciona un libro');
    resetSelect(elements.verseSelect, 'Selecciona un capítulo');
    clearPassageDisplay();
  }

  async function updateChapters() {
    const selectedBookId = elements.bookSelect.value;

    if (!selectedBookId) {
      resetSelect(elements.chapterSelect, 'Selecciona un libro');
      resetSelect(elements.verseSelect, 'Selecciona un capítulo');
      clearPassageDisplay();
      return;
    }

    const book = booksMap.get(selectedBookId);
    let totalChapters = book?.chapters || book?.chapterCount || 0;

    // Respaldo dinámico: Consulta la longitud del JSON del libro si no está en manifest
    if (totalChapters === 0) {
      const chaptersList = await fetchBookDetailData(selectedBookId);
      if (Array.isArray(chaptersList)) {
        totalChapters = chaptersList.length;
      }
    }

    if (totalChapters === 0) {
      resetSelect(elements.chapterSelect, 'Sin capítulos');
      resetSelect(elements.verseSelect, 'Sin versículos');
      return;
    }

    const defaultOpt = new Option('-- Capítulo --', '');
    const options = Array.from({ length: totalChapters }, (_, i) => new Option(`Capítulo ${i + 1}`, i + 1));

    elements.chapterSelect.replaceChildren(defaultOpt, ...options);
    elements.chapterSelect.disabled = false;
    resetSelect(elements.verseSelect, 'Selecciona un capítulo');

    renderPassage();
  }

  async function updateVerses() {
    const selectedBookId = elements.bookSelect.value;
    const chapterVal = elements.chapterSelect.value;

    if (!selectedBookId || !chapterVal) {
      resetSelect(elements.verseSelect, 'Selecciona un capítulo');
      clearPassageDisplay();
      return;
    }

    const chapterNum = parseInt(chapterVal, 10);
    const chapterIdx = chapterNum - 1;
    const book = booksMap.get(selectedBookId);

    if (!book) {
      resetSelect(elements.verseSelect, 'Error de libro');
      return;
    }

    let totalVerses = 0;
    if (Array.isArray(book.verseCounts) && book.verseCounts[chapterIdx] !== undefined) {
      totalVerses = book.verseCounts[chapterIdx];
    } else {
      // Intento de conteo dinámico desde el JSON individual del libro
      const detailData = await fetchBookDetailData(selectedBookId);
      if (Array.isArray(detailData)) {
        const chapterObj = detailData.find(c => Number(c.chapter) === chapterNum) || detailData[chapterIdx];
        if (chapterObj) {
          if (Array.isArray(chapterObj.verses)) {
            totalVerses = chapterObj.verses.length;
          } else if (typeof chapterObj.versesCount === 'number') {
            totalVerses = chapterObj.versesCount;
          }
        }
      }

      if (totalVerses === 0) {
        console.warn(`[Biblia] 'verseCounts' no encontrado para ${book.name} (Cap. ${chapterNum}). Respaldo: ${DEFAULT_VERSE_FALLBACK} versículos.`);
        totalVerses = DEFAULT_VERSE_FALLBACK;
      }
    }

    if (totalVerses <= 0) {
      resetSelect(elements.verseSelect, 'Sin versículos');
      return;
    }

    const defaultOpt = new Option('-- Versículo --', '');
    const options = Array.from({ length: totalVerses }, (_, i) => new Option(`Versículo ${i + 1}`, i + 1));

    elements.verseSelect.replaceChildren(defaultOpt, ...options);
    elements.verseSelect.disabled = false;

    renderPassage();
  }

  // ==========================================
  // 7. RENDERIZADO DINÁMICO E INTERACTIVO (100% DOM seguro)
  // ==========================================
  function clearPassageDisplay() {
    if (elements.passageDisplay) {
      elements.passageDisplay.classList.add('hidden');
      elements.passageDisplay.replaceChildren();
    }
  }

  async function renderPassage() {
    if (!elements.passageDisplay) return;

    const bookId = elements.bookSelect.value;
    const chapterVal = elements.chapterSelect.value;
    const verseVal = elements.verseSelect.value;

    if (!bookId) {
      clearPassageDisplay();
      return;
    }

    const book = booksMap.get(bookId);
    if (!book) return;

    const fragment = document.createDocumentFragment();

    // Badges de Contexto
    const badgeContainer = document.createElement('div');
    badgeContainer.className = 'passage-title-group';
    badgeContainer.style.marginBottom = '0.5rem';

    const testamentName = book.testament === 'OT' 
      ? 'Antiguo Testamento' 
      : (book.testament === 'NT' ? 'Nuevo Testamento' : '');

    if (testamentName) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = testamentName;
      badgeContainer.appendChild(badge);
    }

    if (book.category) {
      const badge = document.createElement('span');
      badge.className = 'badge muted';
      badge.style.marginLeft = '0.4rem';
      badge.textContent = book.category;
      badgeContainer.appendChild(badge);
    }
    fragment.appendChild(badgeContainer);

    // Carga de metadata detallada del capítulo (ej: data/biblia/jhn.json)
    let chapterDetail = null;
    if (chapterVal) {
      const chaptersList = await fetchBookDetailData(bookId);
      if (Array.isArray(chaptersList)) {
        chapterDetail = chaptersList.find(c => Number(c.chapter) === Number(chapterVal));
      }
    }

    // Encabezado Principal
    const titleHeader = document.createElement('div');
    titleHeader.className = 'passage-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'passage-title-group';

    if (chapterDetail?.conceptualSummary?.keyIdea) {
      const keyBadge = document.createElement('span');
      keyBadge.className = 'badge-accent';
      keyBadge.textContent = chapterDetail.conceptualSummary.keyIdea;
      titleGroup.appendChild(keyBadge);
    }

    let titleText = `${book.name}`;
    if (chapterVal) titleText += ` ${chapterVal}`;
    if (verseVal) titleText += `:${verseVal}`;
    if (chapterDetail?.sectionTitle) titleText += `: ${chapterDetail.sectionTitle}`;

    const titleEl = document.createElement('h2');
    titleEl.textContent = titleText;
    titleGroup.appendChild(titleEl);
    titleHeader.appendChild(titleGroup);

    if (chapterDetail?.estimatedReadingTimeMinutes) {
      const timeMeta = document.createElement('span');
      timeMeta.className = 'meta-info';
      timeMeta.textContent = `⏱️ ${chapterDetail.estimatedReadingTimeMinutes} min de lectura`;
      titleHeader.appendChild(timeMeta);
    }

    fragment.appendChild(titleHeader);

    // Renderizado según disponibilidad de guía de estudio
    if (chapterDetail) {
      renderInteractiveStudyModule(fragment, chapterDetail);
    } else {
      const infoEl = document.createElement('p');
      infoEl.style.color = 'var(--text-muted)';
      infoEl.style.marginTop = '0.75rem';
      infoEl.textContent = 'Pasaje seleccionado correctamente.';
      fragment.appendChild(infoEl);
    }

    elements.passageDisplay.replaceChildren(fragment);
    elements.passageDisplay.classList.remove('hidden');
  }

  // Renderiza pestañas, resumen, preguntas y ejercicios interactivos
  function renderInteractiveStudyModule(parentFragment, chapterData) {
    const chapterId = chapterData.chapter;

    // Navegación por pestañas
    const navTabs = document.createElement('nav');
    navTabs.className = 'passage-tabs';
    navTabs.setAttribute('role', 'tablist');
    navTabs.setAttribute('aria-label', 'Secciones del pasaje');

    const createTab = (id, label, active = false) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tab-btn ${active ? 'active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.setAttribute('aria-controls', id);
      btn.id = `btn_${id}`;
      btn.textContent = label;
      return btn;
    };

    const tabSum = createTab('tabSummary', '📝 Resumen', true);
    const tabQue = createTab('tabQuestions', `🤔 Análisis (${chapterData.criticalAnalysisQuestions?.length || 0})`);
    const tabExe = createTab('tabExercise', '🎯 Práctica');

    navTabs.append(tabSum, tabQue, tabExe);
    parentFragment.appendChild(navTabs);

    // Panel 1: Resumen
    const panelSummary = document.createElement('article');
    panelSummary.id = 'tabSummary';
    panelSummary.className = 'tab-content';
    panelSummary.setAttribute('role', 'tabpanel');

    const pSummary = document.createElement('p');
    pSummary.className = 'summary-text';
    pSummary.textContent = chapterData.conceptualSummary?.text || '';

    const footSummary = document.createElement('footer');
    footSummary.className = 'summary-footer';
    const smallCount = document.createElement('small');
    smallCount.className = 'text-muted';
    smallCount.textContent = `Palabras: ${chapterData.conceptualSummary?.wordCount || 0}`;
    footSummary.appendChild(smallCount);

    panelSummary.append(pSummary, footSummary);
    parentFragment.appendChild(panelSummary);

    // Panel 2: Preguntas de Análisis
    const panelQuestions = document.createElement('article');
    panelQuestions.id = 'tabQuestions';
    panelQuestions.className = 'tab-content hidden';
    panelQuestions.setAttribute('role', 'tabpanel');

    const questionsList = document.createElement('div');
    questionsList.className = 'questions-list';

    (chapterData.criticalAnalysisQuestions || []).forEach(q => {
      const noteKey = `q_${chapterId}_${q.id}`;
      const savedText = userNotes[noteKey] || '';

      const card = document.createElement('div');
      card.className = 'question-card';

      const qHeader = document.createElement('div');
      qHeader.className = 'question-header';
      const badgeFocus = document.createElement('span');
      badgeFocus.className = 'badge-focus';
      badgeFocus.textContent = `Enfoque: ${q.focus}`;
      qHeader.appendChild(badgeFocus);

      const qBody = document.createElement('p');
      qBody.className = 'question-body';
      const strongNum = document.createElement('strong');
      strongNum.textContent = `${q.id}. `;
      qBody.append(strongNum, document.createTextNode(q.question));

      const textarea = document.createElement('textarea');
      textarea.className = 'form-control question-input';
      textarea.dataset.key = noteKey;
      textarea.placeholder = 'Escribe tu reflexión sobre este punto...';
      textarea.value = savedText;

      const saveStatus = document.createElement('span');
      saveStatus.className = 'save-status';
      saveStatus.id = `status_${noteKey}`;
      saveStatus.textContent = '✓ Guardado automático';

      card.append(qHeader, qBody, textarea, saveStatus);
      questionsList.appendChild(card);
    });

    panelQuestions.appendChild(questionsList);
    parentFragment.appendChild(panelQuestions);

    // Panel 3: Ejercicio Práctico
    const panelExercise = document.createElement('article');
    panelExercise.id = 'tabExercise';
    panelExercise.className = 'tab-content hidden';
    panelExercise.setAttribute('role', 'tabpanel');

    const exerciseCard = document.createElement('div');
    exerciseCard.className = 'exercise-card';

    const exHeader = document.createElement('div');
    exHeader.className = 'exercise-header';
    const h3Ex = document.createElement('h3');
    h3Ex.textContent = 'Objetivo del Ejercicio';
    const spanDuration = document.createElement('span');
    spanDuration.className = 'badge-time';
    spanDuration.textContent = `⌛ ${chapterData.practicalExercise?.suggestedDurationMinutes || 15} min`;
    exHeader.append(h3Ex, spanDuration);

    const pObj = document.createElement('p');
    pObj.className = 'exercise-objective';
    pObj.textContent = chapterData.practicalExercise?.objective || '';

    const h4Steps = document.createElement('h4');
    h4Steps.className = 'section-subtitle';
    h4Steps.textContent = 'Pasos de Implementación';

    const ulSteps = document.createElement('ul');
    ulSteps.className = 'checklist-group';

    (chapterData.practicalExercise?.instructions || []).forEach((stepText, idx) => {
      const stepKey = `step_${chapterId}_${idx}`;
      const isChecked = Boolean(userNotes[stepKey]);

      const li = document.createElement('li');
      li.className = 'checklist-item';

      const label = document.createElement('label');
      label.className = 'checkbox-label';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.dataset.key = stepKey;
      chk.checked = isChecked;

      const spanText = document.createElement('span');
      spanText.textContent = stepText;

      label.append(chk, spanText);
      li.appendChild(label);
      ulSteps.appendChild(li);
    });

    // Cuestionario / Entregable
    const delivBox = document.createElement('div');
    delivBox.className = 'deliverable-box';

    const delivLabel = document.createElement('label');
    delivLabel.className = 'deliverable-label';
    delivLabel.innerHTML = '📋 <strong>Entregable Generado</strong>';

    const delivDesc = document.createElement('p');
    delivDesc.className = 'deliverable-desc';
    delivDesc.textContent = chapterData.practicalExercise?.deliverable || '';

    const delivKey = `deliv_${chapterId}`;
    const delivArea = document.createElement('textarea');
    delivArea.className = 'form-control';
    delivArea.dataset.key = delivKey;
    delivArea.placeholder = 'Escribe aquí tu plan de acción o entregable final...';
    delivArea.value = userNotes[delivKey] || '';

    const delivStatus = document.createElement('span');
    delivStatus.className = 'save-status';
    delivStatus.id = `status_${delivKey}`;
    delivStatus.textContent = '✓ Guardado automático';

    delivBox.append(delivLabel, delivDesc, delivArea, delivStatus);
    exerciseCard.append(exHeader, pObj, h4Steps, ulSteps, delivBox);
    panelExercise.appendChild(exerciseCard);
    parentFragment.appendChild(panelExercise);
  }

  // Delegación Única de Eventos Interactivos en #passageDisplay
  function initPassageDisplayDelegation() {
    if (!elements.passageDisplay) return;

    // Manejo de pestañas (Tabs)
    elements.passageDisplay.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('.tab-btn');
      if (!tabBtn) return;

      const tabs = elements.passageDisplay.querySelectorAll('.tab-btn');
      const panels = elements.passageDisplay.querySelectorAll('.tab-content');

      tabs.forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });

      panels.forEach(p => p.classList.add('hidden'));

      tabBtn.classList.add('active');
      tabBtn.setAttribute('aria-selected', 'true');

      const targetPanel = elements.passageDisplay.querySelector(`#${tabBtn.getAttribute('aria-controls')}`);
      if (targetPanel) targetPanel.classList.remove('hidden');
    });

    // Manejo de Checkboxes de ejercicios
    elements.passageDisplay.addEventListener('change', (e) => {
      if (e.target.matches('input[type="checkbox"][data-key]')) {
        userNotes[e.target.dataset.key] = e.target.checked;
        saveNotesToStorage();
      }
    });

    // Manejo de entrada de texto (Auto-save)
    elements.passageDisplay.addEventListener('input', (e) => {
      if (e.target.matches('textarea[data-key]')) {
        const key = e.target.dataset.key;
        userNotes[key] = e.target.value;
        saveNotesToStorage();

        const statusEl = elements.passageDisplay.querySelector(`#status_${key}`);
        if (statusEl) {
          statusEl.classList.add('visible');
          clearTimeout(statusEl._timer);
          statusEl._timer = setTimeout(() => statusEl.classList.remove('visible'), 1200);
        }
      }
    });
  }

  // ==========================================
  // 8. MANEJO DE ESTADOS Y BANNERS DE ERROR
  // ==========================================
  function resetSelect(selectEl, placeholder) {
    if (!selectEl) return;
    selectEl.replaceChildren(new Option(placeholder, ''));
    selectEl.disabled = true;
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

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'retry-btn';
    retryBtn.textContent = 'Reintentar';
    retryBtn.addEventListener('click', retryFn, { once: true });

    elements.statusBanner.append(errorSpan, retryBtn);
    elements.statusBanner.classList.remove('hidden');
  }

  function clearStatus() {
    if (elements.statusBanner) {
      elements.statusBanner.classList.add('hidden');
      elements.statusBanner.replaceChildren();
    }
  }

  // ==========================================
  // 9. ESCUCHADORES DE EVENTOS E INICIALIZACIÓN
  // ==========================================
  elements.bookSelect.addEventListener('change', updateChapters);
  elements.chapterSelect.addEventListener('change', updateVerses);
  elements.verseSelect.addEventListener('change', renderPassage);

  initScopeFilter();
  initPassageDisplayDelegation();
  loadManifest();
});
