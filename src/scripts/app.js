// =============================================
// DOM elements
// ---------------------------------------------

const root_element = document.documentElement;
const brand_link = document.getElementById("brand-link");
const search_form = document.getElementById("search-form");
const search_input = document.getElementById("search-input");
const search_button = document.getElementById("search-button");
const theme_toggle = document.getElementById("theme-toggle");
const suggestion_buttons = document.querySelectorAll(".suggestion");
const status_message = document.getElementById("status-message");
const engine_warning = document.getElementById("engine-warning");
const results_list = document.getElementById("results-list");
const skeleton_list = document.getElementById("skeleton-list");
const load_more_button = document.getElementById("load-more-button");

// =============================================
// State
// ---------------------------------------------

const search_state = {
  query: "",
  page: 1,
  is_loading: false,
  shown_count: 0,
  // Identifica la búsqueda actual para ignorar respuestas viejas
  search_id: 0,
};

const OPEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4 10 14"></path><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"></path></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"></path><path d="m7 10 5 5 5-5"></path><path d="M5 20h14"></path></svg>';

// =============================================
// Helpers
// ---------------------------------------------

// Devuelve la longitud de un arreglo, tratando null como vacío
function len_of(items) {
  if (!Array.isArray(items)) {
    return 0;
  }
  return items.length;
}

// Convierte bytes a un tamaño legible (KB, MB)
function format_size(size_bytes) {
  if (size_bytes === null || size_bytes === undefined) {
    return "";
  }
  if (size_bytes >= 1024 * 1024) {
    return `${(size_bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(size_bytes / 1024))} KB`;
}

// Devuelve la URL parseada solo si es http o https
function parse_safe_url(raw_url) {
  let parsed_url;
  try {
    parsed_url = new URL(raw_url);
  } catch (error) {
    console.error(`Invalid result URL: ${raw_url} (${error.message})`);
    return null;
  }
  if (parsed_url.protocol !== "http:" && parsed_url.protocol !== "https:") {
    return null;
  }
  return parsed_url;
}

// Obtiene el nombre del archivo al final de la ruta
function file_name_from_url(parsed_url) {
  const segments = parsed_url.pathname.split("/");
  let last_segment = segments[segments.length - 1];
  try {
    last_segment = decodeURIComponent(last_segment);
  } catch (error) {
    console.warn(`Could not decode file name: ${last_segment} (${error.message})`);
  }
  return last_segment;
}

// Crea un elemento con clase y texto opcionales
function create_element(tag_name, class_name, text) {
  const element = document.createElement(tag_name);
  if (class_name) {
    element.className = class_name;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

// =============================================
// Theme
// ---------------------------------------------

// Devuelve el tema visible: el elegido o el del sistema
function get_effective_theme() {
  const chosen_theme = root_element.dataset.theme;
  if (chosen_theme === "light" || chosen_theme === "dark") {
    return chosen_theme;
  }
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

// Cambia entre claro y oscuro y recuerda la elección
function toggle_theme() {
  let next_theme = "dark";
  if (get_effective_theme() === "dark") {
    next_theme = "light";
  }
  root_element.dataset.theme = next_theme;
  try {
    localStorage.setItem("theme", next_theme);
  } catch (error) {
    console.warn(`Could not save theme: ${error.message}`);
  }
}

// =============================================
// Rendering
// ---------------------------------------------

// Cambia entre la portada y la vista de resultados
function set_view(view_name) {
  document.body.classList.remove("is-home", "is-results");
  document.body.classList.add(`is-${view_name}`);
}

// Muestra un mensaje de estado; kind puede ser "info" o "error"
function set_status(text, kind) {
  status_message.textContent = text;
  status_message.classList.remove("is-error");
  if (kind === "error") {
    status_message.classList.add("is-error");
  }
}

// Muestra u oculta el aviso de motores que no respondieron
function set_engine_warning(unresponsive_engines) {
  if (len_of(unresponsive_engines) === 0) {
    engine_warning.hidden = true;
    engine_warning.textContent = "";
    return;
  }
  const engine_names = [];
  for (const engine of unresponsive_engines) {
    if (!engine_names.includes(engine.name)) {
      engine_names.push(engine.name);
    }
  }
  engine_warning.textContent = `Some engines did not respond: ${engine_names.join(", ")}`;
  engine_warning.hidden = false;
}

// Crea el <li> de un resultado usando textContent (sin HTML externo)
function create_result_item(result, parsed_url) {
  const item = create_element("li", "result");

  // 1. Línea de origen: insignia PDF, dominio y archivo
  const source_line = create_element("div", "result-source");
  let badge_text = "PDF";
  const size_text = format_size(result.size_bytes);
  if (size_text !== "") {
    badge_text = `PDF · ${size_text}`;
  }
  source_line.appendChild(create_element("span", "result-badge", badge_text));
  const path_span = create_element("span", "result-path", parsed_url.hostname);
  const file_name = file_name_from_url(parsed_url);
  if (file_name !== "") {
    path_span.appendChild(create_element("span", "result-path-file", ` › ${file_name}`));
  }
  source_line.appendChild(path_span);
  item.appendChild(source_line);

  // 2. Título enlazado al PDF
  const title_link = create_element("a", "result-title", result.title || file_name || parsed_url.hostname);
  title_link.href = parsed_url.href;
  title_link.target = "_blank";
  title_link.rel = "noopener noreferrer";
  item.appendChild(title_link);

  // 3. Fragmento de texto
  if (result.snippet) {
    item.appendChild(create_element("p", "result-snippet", result.snippet));
  }

  // 4. Acciones (los iconos son constantes propias, no datos externos)
  const actions = create_element("div", "result-actions");
  const open_link = create_element("a", "result-action");
  open_link.href = parsed_url.href;
  open_link.target = "_blank";
  open_link.rel = "noopener noreferrer";
  open_link.innerHTML = OPEN_ICON;
  open_link.appendChild(document.createTextNode("Open"));
  actions.appendChild(open_link);
  const download_link = create_element("a", "result-action");
  download_link.href = `/api/download?${new URLSearchParams({ url: parsed_url.href })}`;
  download_link.innerHTML = DOWNLOAD_ICON;
  download_link.appendChild(document.createTextNode("Download"));
  actions.appendChild(download_link);
  item.appendChild(actions);

  return item;
}

// Agrega una página de resultados a la lista
function render_results(results) {
  for (const result of results) {
    const parsed_url = parse_safe_url(result.url);
    if (parsed_url !== null) {
      results_list.appendChild(create_result_item(result, parsed_url));
      search_state.shown_count += 1;
    }
  }
}

// =============================================
// Search
// ---------------------------------------------

// Activa o desactiva los controles mientras se busca
function set_loading(is_loading, is_first_page) {
  search_state.is_loading = is_loading;
  search_button.disabled = is_loading;
  load_more_button.disabled = is_loading;
  skeleton_list.hidden = !(is_loading && is_first_page);
  if (is_loading && !is_first_page) {
    load_more_button.textContent = "Loading...";
  } else {
    load_more_button.textContent = "Load more results";
  }
}

// Pide una página de resultados al servidor y la pinta
async function run_search(query, page) {
  // 1. Preparar estado y avisar
  const search_id = search_state.search_id;
  const is_first_page = page === 1;
  const started_at = performance.now();
  set_loading(true, is_first_page);
  if (is_first_page) {
    set_status("Searching and checking PDFs...", "info");
  }

  try {
    // 2. Llamar a la API propia
    const params = new URLSearchParams({ q: query, page: String(page) });
    const response = await fetch(`/api/search?${params}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Server responded with status ${response.status}`);
    }

    // Ignorar si el usuario ya lanzó otra búsqueda
    if (search_id !== search_state.search_id) {
      return;
    }

    // 3. Pintar resultados y avisos
    render_results(data.results);
    set_engine_warning(data.unresponsive_engines);

    // 4. Resumen: cantidad, tiempo y caché
    const elapsed_ms = performance.now() - started_at;
    let elapsed_text = `${(elapsed_ms / 1000).toFixed(1)} s`;
    if (elapsed_ms < 1000) {
      elapsed_text = `${Math.max(1, Math.round(elapsed_ms))} ms`;
    }
    if (search_state.shown_count === 0 && !data.has_more) {
      set_status(`No PDFs found for "${query}". Try other words.`, "info");
    } else {
      let summary = `${search_state.shown_count} PDFs · ${elapsed_text}`;
      if (data.cached) {
        summary = `${summary} · cached`;
      }
      set_status(summary, "info");
    }

    // 5. Mostrar "Load more" solo si el buscador trajo candidatos
    load_more_button.hidden = !data.has_more;
  } catch (error) {
    if (search_id !== search_state.search_id) {
      return;
    }
    console.error(`Search failed: ${error.message}`);
    set_status(`Search failed: ${error.message}`, "error");
  } finally {
    if (search_id === search_state.search_id) {
      set_loading(false, is_first_page);
    }
  }
}

// Empieza una búsqueda nueva desde la página 1
function start_search(query, update_url) {
  // 1. Reiniciar estado y lista
  search_state.search_id += 1;
  search_state.query = query;
  search_state.page = 1;
  search_state.shown_count = 0;
  results_list.replaceChildren();
  load_more_button.hidden = true;
  set_engine_warning([]);

  // 2. Reflejar la búsqueda en la URL y el título
  search_input.value = query;
  document.title = `${query} - Seraphim Vision`;
  if (update_url) {
    history.pushState({ query }, "", `/?${new URLSearchParams({ q: query })}`);
  }

  // 3. Cambiar a la vista de resultados y buscar
  set_view("results");
  window.scrollTo({ top: 0 });
  run_search(query, 1);
}

// Vuelve a la portada
function show_home(update_url) {
  search_state.search_id += 1;
  search_state.query = "";
  results_list.replaceChildren();
  load_more_button.hidden = true;
  set_loading(false, true);
  set_status("", "info");
  set_engine_warning([]);
  search_input.value = "";
  document.title = "Seraphim Vision";
  if (update_url) {
    history.pushState({}, "", "/");
  }
  set_view("home");
  search_input.focus();
}

// Lee ?q= de la URL y muestra la vista correspondiente
function load_from_url() {
  const query = (new URLSearchParams(window.location.search).get("q") || "").trim();
  if (query === "") {
    show_home(false);
  } else {
    start_search(query, false);
  }
}

// =============================================
// Event listeners
// ---------------------------------------------

// Nueva búsqueda desde el formulario
search_form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = search_input.value.trim();
  if (query === "") {
    return;
  }
  search_input.blur();
  start_search(query, true);
});

// Siguiente página de la búsqueda actual
load_more_button.addEventListener("click", () => {
  if (search_state.is_loading) {
    return;
  }
  search_state.page += 1;
  run_search(search_state.query, search_state.page);
});

// Búsquedas de ejemplo en la portada
for (const suggestion_button of suggestion_buttons) {
  suggestion_button.addEventListener("click", () => {
    start_search(suggestion_button.textContent.trim(), true);
  });
}

// El logo vuelve a la portada sin recargar
brand_link.addEventListener("click", (event) => {
  event.preventDefault();
  show_home(true);
});

theme_toggle.addEventListener("click", toggle_theme);

// Botones Atrás / Adelante del navegador
window.addEventListener("popstate", load_from_url);

// "/" enfoca la barra de búsqueda si no se está escribiendo
document.addEventListener("keydown", (event) => {
  const active_tag = document.activeElement.tagName;
  if (event.key === "/" && active_tag !== "INPUT" && active_tag !== "TEXTAREA") {
    event.preventDefault();
    search_input.focus();
    search_input.select();
  }
});

// =============================================
// Startup
// ---------------------------------------------

load_from_url();
