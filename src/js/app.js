'use strict'; // Forzamos modo estricto para capturar errores silenciosos

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

  // Detenemos la ejecución si faltan nodos estructurales clave
  if (!elements.bookSelect || !elements.chapterSelect || !elements.verseSelect) {
    console.error('[Biblia App] Faltan elementos críticos del DOM. Verifica la plantilla HTML.');
    return;
  }

  let booksList = [];
  let booksMap = new Map(); // Indexación O(1) para búsqueda rápida de libros por ID/código
  let currentScope = 'ALL'; // Estado global del filtro de ámbito ('ALL' | 'OT' | 'NT')
  const DEFAULT_VERSE_FALLBACK = 50;

  // ==========================================
  // 2. GESTIÓN DE MODO OSCURO (Con soporte A11y)
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
  // 3. CARGA DE DATOS BÍBLICOS CON CACHÉ
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
          id: key,
          ...value
        }));
      }

      if (!rawBooks.length) throw new Error('El manifest no contiene libros válidos.');

      // Búsqueda instantánea O(1)
      booksMap = new Map(rawBooks.map(b => [b.id || b.code, b]));
      booksList = Array.from(booksMap.values());

      updateBadgeCounts();
      clearStatus();
      populateBooks();

    } catch (error) {
      console.error('[Biblia App] Error al cargar manifest:', error);
      showError('Error al cargar la lista de libros. Revisa la ruta de manifest.json.', loadManifest);
    }
  }

  // Actualiza los contadores de las etiquetas en los botones de ámbito
  function updateBadgeCounts() {
    const otCount = booksList.filter(b => b.testament === 'OT').length;
    const ntCount = booksList.filter(b => b.testament === 'NT').length;

    if (elements.badgeAll) elements.badgeAll.textContent = booksList.length;
    if (elements.badgeOT) elements.badgeOT.textContent = otCount;
    if (elements.badgeNT) elements.badgeNT.textContent = ntCount;
  }

  // ==========================================
  // 4. CONTROLADOR DEL FILTRO DE ÁMBITO (BOTONES)
  // ==========================================
  function initScopeFilter() {
    if (!elements.scopeFilter) return;

    // Delegación de eventos eficiente en el contenedor padre
    elements.scopeFilter.addEventListener('click', (e) => {
      const btn = e.target.closest('.scope-btn');
      if (!btn || !btn.dataset.scope) return;

      const selectedScope = btn.dataset.scope;
      if (selectedScope === currentScope) return;

      currentScope = selectedScope;

      // Actualización de estado visual e interactivo
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
  // 5. POBLADO Y ACTUALIZACIÓN DE SELECTORES
  // ==========================================
  function populateBooks() {
    elements.bookSelect.replaceChildren(new Option('-- Seleccionar Libro --', ''));

    // Filtrar la lista de libros según el ámbito activo
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
        const option = new Option(b.name, b.id || b.code);
        if (b.testament === 'OT') groupOT.appendChild(option);
        else if (b.testament === 'NT') groupNT.appendChild(option);
        else elements.bookSelect.appendChild(option);
      });

      if (groupOT.children.length > 0) elements.bookSelect.appendChild(groupOT);
      if (groupNT.children.length > 0) elements.bookSelect.appendChild(groupNT);
    } else {
      filteredBooks.forEach(b => {
        elements.bookSelect.appendChild(new Option(b.name, b.id || b.code));
      });
    }

    elements.bookSelect.disabled = filteredBooks.length === 0;

    // Reinicio de selectores dependientes y visor
    resetSelect(elements.chapterSelect, 'Selecciona un libro');
    resetSelect(elements.verseSelect, 'Selecciona un capítulo');
    clearPassageDisplay();
  }

  function updateChapters() {
    const selectedBookId = elements.bookSelect.value;

    if (!selectedBookId) {
      resetSelect(elements.chapterSelect, 'Selecciona un libro');
      resetSelect(elements.verseSelect, 'Selecciona un capítulo');
      clearPassageDisplay();
      return;
    }

    const book = booksMap.get(selectedBookId);
    const totalChapters = book?.chapters || book?.chapterCount || 0;

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

  function updateVerses() {
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
      console.warn(`[Biblia] 'verseCounts' no encontrado para ${book.name} (Cap. ${chapterNum}). Respaldo: ${DEFAULT_VERSE_FALLBACK} versículos.`);
      totalVerses = DEFAULT_VERSE_FALLBACK;
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
  // 6. RENDERIZADO SEGURO EN PANTALLA
  // ==========================================
  function clearPassageDisplay() {
    if (elements.passageDisplay) {
      elements.passageDisplay.classList.add('hidden');
      elements.passageDisplay.replaceChildren();
    }
  }

  function renderPassage() {
    if (!elements.passageDisplay) return;

    const bookId = elements.bookSelect.value;
    const chapter = elements.chapterSelect.value;
    const verse = elements.verseSelect.value;

    if (!bookId) {
      clearPassageDisplay();
      return;
    }

    const book = booksMap.get(bookId);
    if (!book) return;

    const testamentName = book.testament === 'OT' 
      ? 'Antiguo Testamento' 
      : (book.testament === 'NT' ? 'Nuevo Testamento' : '');

    let titleText = `${book.name}`;
    if (chapter) titleText += ` ${chapter}`;
    if (verse) titleText += `:${verse}`;

    // Construcción del DOM 100% libre de innerHTML
    elements.passageDisplay.classList.remove('hidden');
    elements.passageDisplay.replaceChildren();

    const badgeContainer = document.createElement('div');
    badgeContainer.style.marginBottom = '0.5rem';

    if (testamentName) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = testamentName;
      badgeContainer.appendChild(badge);
    }

    if (book.category) {
      const badge = document.createElement('span');
      badge.className = 'badge muted';
      badge.textContent = book.category;
      badgeContainer.appendChild(badge);
    }

    const titleEl = document.createElement('h3');
    titleEl.textContent = titleText;

    const infoEl = document.createElement('p');
    infoEl.style.color = 'var(--text-muted)';
    infoEl.textContent = 'Pasaje seleccionado correctamente.';

    elements.passageDisplay.append(badgeContainer, titleEl, infoEl);
  }

  // ==========================================
  // 7. MANEJO DE ESTADOS Y BANNERS DE ERROR
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
  // 8. ESCUCHADORES DE EVENTOS E INICIALIZACIÓN
  // ==========================================
  elements.bookSelect.addEventListener('change', updateChapters);
  elements.chapterSelect.addEventListener('change', updateVerses);
  elements.verseSelect.addEventListener('change', renderPassage);

  // Inicializar listeners y carga de datos
  initScopeFilter();
  loadManifest();
});
