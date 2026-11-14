// =============================================
// DOM elements
// ---------------------------------------------

const search_form = document.getElementById("search-form");
const search_input = document.getElementById("search-input");
const search_button = document.getElementById("search-button");
const status_message = document.getElementById("status-message");
const engine_warning = document.getElementById("engine-warning");
const results_list = document.getElementById("results-list");
const load_more_button = document.getElementById("load-more-button");

// =============================================
// State
// ---------------------------------------------

const search_state = {
  query: "",
  page: 1,
  is_loading: false,
  shown_count: 0,
};

// =============================================
// Formatting helpers
// ---------------------------------------------

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

// Devuelve true solo para URLs http o https
function is_safe_link(raw_url) {
  let parsed_url;
  try {
    parsed_url = new URL(raw_url);
  } catch (error) {
    console.error(`Invalid result URL: ${raw_url} (${error.message})`);
    return false;
  }
  return parsed_url.protocol === "http:" || parsed_url.protocol === "https:";
}

// =============================================
// Rendering
// ---------------------------------------------

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
    engine_names.push(engine.name);
  }
  engine_warning.textContent = `Some search engines did not respond: ${engine_names.join(", ")}.`;
  engine_warning.hidden = false;
}

// Devuelve la longitud de un arreglo, tratando null como vacío
function len_of(items) {
  if (!Array.isArray(items)) {
    return 0;
  }
  return items.length;
}

// Crea el elemento <li> de un resultado usando textContent (sin innerHTML)
function create_result_item(result) {
  const item = document.createElement("li");
  item.className = "result-card";

  // Título enlazado al PDF original
  const title_link = document.createElement("a");
  title_link.className = "result-title";
  title_link.href = result.url;
  title_link.target = "_blank";
  title_link.rel = "noopener noreferrer";
  title_link.textContent = result.title || result.url;
  item.appendChild(title_link);

  // Línea con dominio y tamaño
  const meta_line = document.createElement("p");
  meta_line.className = "result-meta";
  const domain_span = document.createElement("span");
  domain_span.className = "result-domain";
  domain_span.textContent = result.domain;
  meta_line.appendChild(domain_span);
  const size_text = format_size(result.size_bytes);
  if (size_text !== "") {
    const size_span = document.createElement("span");
    size_span.className = "result-size";
    size_span.textContent = size_text;
    meta_line.appendChild(size_span);
  }
  item.appendChild(meta_line);

  // Fragmento de texto, si el buscador lo trae
  if (result.snippet) {
    const snippet = document.createElement("p");
    snippet.className = "result-snippet";
    snippet.textContent = result.snippet;
    item.appendChild(snippet);
  }

  // Botones de abrir y descargar
  const actions = document.createElement("div");
  actions.className = "result-actions";
  const open_link = document.createElement("a");
  open_link.className = "action-button";
  open_link.href = result.url;
  open_link.target = "_blank";
  open_link.rel = "noopener noreferrer";
  open_link.textContent = "Open PDF";
  actions.appendChild(open_link);
  const download_link = document.createElement("a");
  download_link.className = "action-button is-secondary";
  download_link.href = `/api/download?${new URLSearchParams({ url: result.url })}`;
  download_link.textContent = "Download";
  actions.appendChild(download_link);
  item.appendChild(actions);

  return item;
}

// Agrega una página de resultados a la lista
function render_results(results) {
  for (const result of results) {
    if (is_safe_link(result.url)) {
      results_list.appendChild(create_result_item(result));
      search_state.shown_count += 1;
    }
  }
}

// =============================================
// Search
// ---------------------------------------------

// Activa o desactiva los controles mientras se busca
function set_loading(is_loading) {
  search_state.is_loading = is_loading;
  search_button.disabled = is_loading;
  load_more_button.disabled = is_loading;
}

// Pide una página de resultados al servidor y la pinta
async function run_search(query, page) {
  // 1. Bloquear controles y avisar
  set_loading(true);
  set_status(`Searching PDFs for "${query}" (page ${page})...`, "info");

  try {
    // 2. Llamar a la API propia
    const params = new URLSearchParams({ q: query, page: String(page) });
    const response = await fetch(`/api/search?${params}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Server responded with status ${response.status}`);
    }

    // 3. Pintar resultados y avisos
    render_results(data.results);
    set_engine_warning(data.unresponsive_engines);

    // 4. Mensaje de resumen
    if (search_state.shown_count === 0 && !data.has_more) {
      set_status(`No PDFs found for "${query}".`, "info");
    } else {
      set_status(`${search_state.shown_count} verified PDFs for "${query}". Page ${page}: ${len_of(data.results)} PDFs, ${data.rejected} links discarded.`, "info");
    }

    // 5. Mostrar "Load more" solo si el buscador trajo candidatos
    load_more_button.hidden = !data.has_more;
  } catch (error) {
    console.error(`Search failed: ${error.message}`);
    set_status(`Search failed: ${error.message}`, "error");
  } finally {
    set_loading(false);
  }
}

// =============================================
// Event listeners
// ---------------------------------------------

// Nueva búsqueda desde el formulario
search_form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = search_input.value.trim();
  if (query === "" || search_state.is_loading) {
    return;
  }

  // Reiniciar estado y lista
  search_state.query = query;
  search_state.page = 1;
  search_state.shown_count = 0;
  results_list.replaceChildren();
  load_more_button.hidden = true;
  set_engine_warning([]);

  run_search(search_state.query, search_state.page);
});

// Siguiente página de la búsqueda actual
load_more_button.addEventListener("click", () => {
  if (search_state.is_loading) {
    return;
  }
  search_state.page += 1;
  run_search(search_state.query, search_state.page);
});
