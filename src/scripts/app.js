// =============================================
// DOM elements
// ---------------------------------------------

const search_form = document.getElementById("search-form");
const search_input = document.getElementById("search-input");
const search_button = document.getElementById("search-button");
const search_label = search_button.querySelector(".ax_face > span");
const suggestion_buttons = document.querySelectorAll(".sv_suggestion");
const results_title = document.getElementById("results-title");
const status_body = document.getElementById("status-body");
const results_list = document.getElementById("results-list");
const ghost_list = document.getElementById("ghost-list");
const load_more_button = document.getElementById("load-more-button");
const load_more_label = load_more_button.querySelector(".ax_face > span");
const home_link = document.getElementById("home-link");
const home_logo = document.querySelector(".sv_logo");

// =============================================
// Constants and state
// ---------------------------------------------

// Colores de marco que se reparten entre sitios (los nombres son variables de axm.css)
const RESULT_ACCENTS = ["cyan", "violet", "green", "pink"];
const LOAD_MORE_TEXT = "Load more";
const LOADING_TEXT = "Loading...";
const SEARCH_TEXT = "Search";
const SCANNING_TEXT = "Scanning";

// Motores que consulta el servidor (ENGINE_GROUPS en server.js), para el log de progreso
const SEARCH_ENGINES = ["brave", "google cse", "duckduckgo", "yandex"];

// Ritmo de la animación de progreso
const STAGE_INTERVAL_MS = 450;
const SCAN_TICK_MS = 110;
const SCAN_WIDTH = 18;
const SCAN_BLOCK = 4;
const STATUS_LINE_DELAY_MS = 130;
const RESULT_REVEAL_STEP_MS = 90;
const RESULT_REVEAL_MAX_STEPS = 8;

const search_state = {
  query: "",
  page: 1,
  is_loading: false,
  shown_count: 0,
  // Identifica la búsqueda actual para ignorar respuestas viejas
  search_id: 0,
};

// Temporizadores y línea de escaneo de la animación de progreso
const progress_state = {
  stage_timer: null,
  scan_timer: null,
  scan_paragraph: null,
};

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

// Crea un elemento con clase y texto opcionales (siempre con textContent)
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

// Elige siempre el mismo color de marco para el mismo sitio
function pick_accent(hostname) {
  let hash = 0;
  for (const character of hostname) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return RESULT_ACCENTS[hash % len_of(RESULT_ACCENTS)];
}

// Lista sin repetir los nombres de los motores que no respondieron
function get_engine_names(unresponsive_engines) {
  const engine_names = [];
  if (!Array.isArray(unresponsive_engines)) {
    return engine_names;
  }
  for (const engine of unresponsive_engines) {
    if (!engine_names.includes(engine.name)) {
      engine_names.push(engine.name);
    }
  }
  return engine_names;
}

// Espera una cantidad de milisegundos
function wait_ms(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// Indica si el usuario pidió menos movimiento en el sistema
function prefers_reduced_motion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// =============================================
// Particles (axm.js solo conecta los elementos que existen al cargar)
// ---------------------------------------------

// Conecta las partículas de axm.js a un elemento creado después
function attach_particles(element) {
  if (prefers_reduced_motion()) {
    return;
  }
  let emitter = null;

  // Ráfaga al entrar y emisión continua mientras el cursor siga encima
  element.addEventListener("pointerenter", () => {
    ax_spawn_particles(element, AX_PARTICLES_ON_ENTER);
    if (emitter === null) {
      emitter = setInterval(() => {
        // Si la carta ya no está en la página, deja de emitir
        if (!element.isConnected) {
          clearInterval(emitter);
          emitter = null;
          return;
        }
        ax_spawn_particles(element, AX_PARTICLES_PER_TICK);
      }, AX_PARTICLE_TICK_MS);
    }
  });

  element.addEventListener("pointerleave", () => {
    if (emitter !== null) {
      clearInterval(emitter);
      emitter = null;
    }
  });
}

// =============================================
// Status terminal (log que se escribe solo, como una terminal real)
// ---------------------------------------------

// Quita el cursor de bloque de la terminal
function remove_status_cursor() {
  const cursor = status_body.querySelector(".ax_cursor");
  if (cursor !== null) {
    cursor.remove();
  }
}

// Baja el log hasta la última línea
function scroll_status_to_end() {
  status_body.scrollTop = status_body.scrollHeight;
}

// Agrega una línea al final con el cursor detrás; kind es info, gen, warn, glitch o dim
function append_status_line(kind, text) {
  remove_status_cursor();
  const paragraph = create_element("p", `ax_term_${kind}`, text);
  paragraph.appendChild(create_element("span", "ax_cursor"));
  status_body.appendChild(paragraph);
  scroll_status_to_end();
}

// Agrega varias líneas con una pausa corta entre cada una; se corta si hay otra búsqueda
async function append_status_lines(lines, search_id) {
  for (const line of lines) {
    if (search_id !== search_state.search_id) {
      return;
    }
    append_status_line(line.kind, line.text);
    await wait_ms(STATUS_LINE_DELAY_MS);
  }
}

// Dibuja la barra de escaneo: un bloque que recorre la barra
function build_scan_frame(position) {
  let frame = "";
  for (let index = 0; index < SCAN_WIDTH; index++) {
    if (index >= position && index < position + SCAN_BLOCK) {
      frame += "#";
    } else {
      frame += ".";
    }
  }
  return `[${frame}]`;
}

// Detiene la animación de progreso y quita la línea de escaneo
function stop_progress() {
  if (progress_state.stage_timer !== null) {
    clearInterval(progress_state.stage_timer);
    progress_state.stage_timer = null;
  }
  if (progress_state.scan_timer !== null) {
    clearInterval(progress_state.scan_timer);
    progress_state.scan_timer = null;
  }
  if (progress_state.scan_paragraph !== null) {
    progress_state.scan_paragraph.remove();
    progress_state.scan_paragraph = null;
  }
}

// Arma las etapas del log: reflejan lo que hace el servidor (motores en paralelo y verificación)
function build_progress_stages(query, is_new_search) {
  const stages = [];
  if (is_new_search) {
    stages.push({ kind: "info", text: `> search "${query}"` });
  } else {
    stages.push({ kind: "info", text: "> load more" });
  }
  stages.push({ kind: "gen", text: "connecting to engines ......" });
  for (const engine_name of SEARCH_ENGINES) {
    stages.push({ kind: "gen", text: `[${engine_name}] querying ...` });
  }
  stages.push({ kind: "gen", text: "merging results ......" });
  stages.push({ kind: "gen", text: "checking links, real pdfs only ......" });
  return stages;
}

// Inicia el log de progreso y la barra de escaneo mientras llega la respuesta
function start_progress(query, is_new_search) {
  stop_progress();
  if (is_new_search) {
    status_body.replaceChildren();
  }
  remove_status_cursor();

  // 1. Línea de escaneo al final, con el cursor parpadeando
  const scan_paragraph = create_element("p", "ax_term_info");
  const scan_text = create_element("span", "", build_scan_frame(0));
  scan_paragraph.appendChild(scan_text);
  scan_paragraph.appendChild(create_element("span", "ax_cursor"));
  status_body.appendChild(scan_paragraph);
  progress_state.scan_paragraph = scan_paragraph;

  // 2. Las etapas se escriben una por una, siempre encima de la línea de escaneo
  const stages = build_progress_stages(query, is_new_search);
  let stage_index = 0;
  let has_waiting_line = false;
  const add_next_stage = () => {
    if (stage_index < len_of(stages)) {
      const stage = stages[stage_index];
      status_body.insertBefore(create_element("p", `ax_term_${stage.kind}`, stage.text), scan_paragraph);
      stage_index += 1;
    } else if (!has_waiting_line) {
      // Si el servidor tarda más que las etapas, se avisa que sigue trabajando
      status_body.insertBefore(create_element("p", "ax_term_warn", "waiting for slow engines ......"), scan_paragraph);
      has_waiting_line = true;
      clearInterval(progress_state.stage_timer);
      progress_state.stage_timer = null;
    }
    scroll_status_to_end();
  };
  add_next_stage();
  progress_state.stage_timer = setInterval(add_next_stage, STAGE_INTERVAL_MS);

  // 3. El bloque de la barra de escaneo va y viene (quieto si se pidió menos movimiento)
  if (!prefers_reduced_motion()) {
    let position = 0;
    let step = 1;
    progress_state.scan_timer = setInterval(() => {
      position += step;
      if (position >= SCAN_WIDTH - SCAN_BLOCK) {
        position = SCAN_WIDTH - SCAN_BLOCK;
        step = -1;
      } else if (position <= 0) {
        position = 0;
        step = 1;
      }
      scan_text.textContent = build_scan_frame(position);
    }, SCAN_TICK_MS);
  }
}

// =============================================
// Rendering
// ---------------------------------------------

// Cambia entre la portada y la vista de resultados
function set_view(view_name) {
  document.body.classList.remove("is_home", "is_results");
  document.body.classList.add(`is_${view_name}`);
}

// Crea un botón de acción como enlace; accent_name es una variable de axm.css
function create_action_button(label, href, accent_name) {
  const button = create_element("a", "ax_frame ax_button ax_button_small");
  button.style.setProperty("--accent", `var(--${accent_name})`);
  button.href = href;
  const face = create_element("span", "ax_face");
  face.appendChild(create_element("span", "", label));
  button.appendChild(face);
  return button;
}

// Crea el <li> de un resultado: carta con marco de color
function create_result_item(result, parsed_url, result_number) {
  const item = create_element("li", "sv_result");
  const card = create_element("div", "ax_frame ax_card");
  card.style.setProperty("--accent", `var(--${pick_accent(parsed_url.hostname)})`);
  const face = create_element("div", "ax_face ax_traces ax_card_face");

  // 1. Número y tamaño
  let index_text = `#${result_number}`;
  const size_text = format_size(result.size_bytes);
  if (size_text !== "") {
    index_text = `${index_text} // ${size_text}`;
  }
  face.appendChild(create_element("span", "ax_card_index", index_text));

  // 2. Título enlazado al PDF original
  const file_name = file_name_from_url(parsed_url);
  const title_heading = create_element("h3", "sv_result_title");
  const title_link = create_element("a", "sv_result_link", result.title || file_name || parsed_url.hostname);
  title_link.href = parsed_url.href;
  title_link.target = "_blank";
  title_link.rel = "noopener noreferrer";
  title_heading.appendChild(title_link);
  face.appendChild(title_heading);

  // 3. Dominio y archivo
  let path_text = parsed_url.hostname;
  if (file_name !== "") {
    path_text = `${parsed_url.hostname}/${file_name}`;
  }
  face.appendChild(create_element("p", "sv_result_path", path_text));

  // 4. Fragmento de texto
  if (result.snippet) {
    face.appendChild(create_element("p", "ax_card_desc sv_result_snippet", result.snippet));
  }

  // 5. Motores que lo encontraron
  if (len_of(result.engines) > 0) {
    const engine_list = create_element("ul", "ax_pill_list");
    for (const engine_name of result.engines) {
      engine_list.appendChild(create_element("li", "", engine_name));
    }
    face.appendChild(engine_list);
  }

  // 6. Acciones: abrir en secundario, descargar en dorado
  const actions = create_element("div", "ax_card_actions ax_card_actions_row");
  const open_button = create_action_button("Open", parsed_url.href, "violet");
  open_button.target = "_blank";
  open_button.rel = "noopener noreferrer";
  const download_button = create_action_button(
    "Download",
    `/api/download?${new URLSearchParams({ url: parsed_url.href })}`,
    "gold_button",
  );
  actions.appendChild(open_button);
  actions.appendChild(download_button);
  face.appendChild(actions);

  card.appendChild(face);
  item.appendChild(card);

  // Partículas al pasar el cursor, como en el resto del estilo
  attach_particles(card);
  attach_particles(open_button);
  attach_particles(download_button);
  return item;
}

// Agrega una página de resultados a la lista; cada carta aparece un poco después de la anterior
function render_results(results) {
  let page_position = 0;
  for (const result of results) {
    const parsed_url = parse_safe_url(result.url);
    if (parsed_url !== null) {
      search_state.shown_count += 1;
      const item = create_result_item(result, parsed_url, search_state.shown_count);
      const reveal_step = Math.min(page_position, RESULT_REVEAL_MAX_STEPS);
      item.style.setProperty("--reveal_delay", `${reveal_step * RESULT_REVEAL_STEP_MS}ms`);
      results_list.appendChild(item);
      page_position += 1;
    }
  }
}

// =============================================
// Search
// ---------------------------------------------

// Activa o desactiva los controles y la animación de espera
function set_loading(is_loading, show_ghosts) {
  search_state.is_loading = is_loading;
  search_button.disabled = is_loading;
  load_more_button.disabled = is_loading;
  document.body.classList.toggle("is_searching", is_loading);
  ghost_list.hidden = !(is_loading && show_ghosts);
  if (is_loading) {
    search_label.textContent = SCANNING_TEXT;
    load_more_label.textContent = LOADING_TEXT;
  } else {
    search_label.textContent = SEARCH_TEXT;
    load_more_label.textContent = LOAD_MORE_TEXT;
  }
}

// Texto del tiempo de respuesta: milisegundos si fue menos de un segundo
function format_elapsed(elapsed_ms) {
  if (elapsed_ms < 1000) {
    return `${Math.max(1, Math.round(elapsed_ms))} ms`;
  }
  return `${(elapsed_ms / 1000).toFixed(1)} s`;
}

// Líneas del resumen final que se agregan al log
function build_summary_lines(data, elapsed_ms) {
  const lines = [];
  if (search_state.shown_count === 0 && !data.has_more) {
    lines.push({ kind: "warn", text: "[warn] no pdfs found, try other words" });
  } else if (search_state.shown_count === 0) {
    lines.push({ kind: "warn", text: "[warn] no pdfs on this page, load more" });
  } else {
    lines.push({ kind: "gen", text: `found: ${search_state.shown_count} pdfs [OK]` });
  }
  let time_text = `time: ${format_elapsed(elapsed_ms)}`;
  if (data.cached) {
    time_text = `${time_text} (cache)`;
  }
  lines.push({ kind: "gen", text: time_text });
  const engine_names = get_engine_names(data.unresponsive_engines);
  if (len_of(engine_names) > 0) {
    lines.push({ kind: "warn", text: `[warn] engines down: ${engine_names.join(", ")}` });
  }
  lines.push({ kind: "info", text: "ready" });
  return lines;
}

// Pide una página de resultados al servidor y la pinta
async function run_search(query, page) {
  // 1. Preparar estado y arrancar la animación de espera
  const search_id = search_state.search_id;
  const started_at = performance.now();
  set_loading(true, page === 1);
  start_progress(query, page === 1);

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

    // 3. Pintar los resultados y liberar los controles
    const elapsed_ms = performance.now() - started_at;
    render_results(data.results);
    stop_progress();
    set_loading(false, false);
    load_more_button.hidden = !data.has_more;

    // 4. El resumen se escribe en el mismo log, línea por línea
    await append_status_lines(build_summary_lines(data, elapsed_ms), search_id);
  } catch (error) {
    if (search_id !== search_state.search_id) {
      return;
    }
    console.error(`Search failed: ${error.message}`);
    stop_progress();
    set_loading(false, false);
    await append_status_lines([
      { kind: "warn", text: `[error] ${error.message}` },
      { kind: "info", text: "ready" },
    ], search_id);
  }
}

// Empieza una búsqueda nueva desde la página 1
function start_search(query, update_url) {
  // 1. Reiniciar estado y lista
  const was_home = document.body.classList.contains("is_home");
  search_state.search_id += 1;
  search_state.query = query;
  search_state.page = 1;
  search_state.shown_count = 0;
  results_list.replaceChildren();
  load_more_button.hidden = true;

  // 2. Reflejar la búsqueda en la URL y el título
  search_input.value = query;
  document.title = `${query} - Seraphim Vision`;
  if (update_url) {
    history.pushState({ query }, "", `/?${new URLSearchParams({ q: query })}`);
  }

  // 3. Cambiar a resultados; el glitch solo suena al entrar desde la portada
  set_view("results");
  if (was_home) {
    ax_play_glitch(results_title);
  }
  window.scrollTo({ top: 0 });
  run_search(query, 1);
}

// Vuelve a la portada
function show_home(update_url) {
  search_state.search_id += 1;
  search_state.query = "";
  results_list.replaceChildren();
  status_body.replaceChildren();
  load_more_button.hidden = true;
  stop_progress();
  set_loading(false, false);
  search_input.value = "";
  document.title = "Seraphim Vision";
  if (update_url) {
    history.pushState({}, "", "/");
  }
  set_view("home");
  // Glitch corto del logo al entrar a la portada
  ax_play_glitch(home_logo);
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

// El enlace "home" de la vista de resultados vuelve a la portada
home_link.addEventListener("click", (event) => {
  event.preventDefault();
  show_home(true);
});

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
