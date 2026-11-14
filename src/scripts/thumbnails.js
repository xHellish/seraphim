// =============================================
// Constants
// ---------------------------------------------

// pdf.js está copiado en src/vendor/pdfjs (ver Documentation.md)
const PDFJS_URL = new URL("../vendor/pdfjs/pdf.min.mjs", import.meta.url).href;
const PDFJS_WORKER_URL = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

// Trozos que se piden al servidor; coincide con el tamaño por defecto de pdf.js
const RANGE_CHUNK_BYTES = 65536;
const MAX_CONCURRENT_THUMBNAILS = 3;
const THUMBNAIL_WIDTH_CSS_PX = 150;
const MAX_DEVICE_PIXEL_RATIO = 2;
// Evita lienzos enormes con páginas gigantes
const MAX_CANVAS_PIXELS = 1500000;
const THUMBNAIL_TIMEOUT_MS = 25000;
// La miniatura se pide un poco antes de que la carta llegue a la pantalla
const VISIBILITY_MARGIN = "300px 0px";

// =============================================
// State
// ---------------------------------------------

const thumbnail_urls = new WeakMap();
const pending_containers = [];
let active_jobs = 0;
let pdfjs_promise = null;
let shared_worker = null;
let visibility_observer = null;

// =============================================
// Helpers
// ---------------------------------------------

// Carga pdf.js la primera vez que hace falta (son unos 1.7 MB, no se bajan si no hay miniaturas)
function load_pdfjs() {
  if (pdfjs_promise === null) {
    pdfjs_promise = import(PDFJS_URL).then((pdfjs_lib) => {
      pdfjs_lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return pdfjs_lib;
    }).catch((error) => {
      // Se permite reintentar en la siguiente miniatura
      pdfjs_promise = null;
      throw error;
    });
  }
  return pdfjs_promise;
}

// Un solo worker de pdf.js para todas las miniaturas (cada uno pesa más de 1 MB)
function get_worker(pdfjs_lib) {
  if (shared_worker === null) {
    shared_worker = new pdfjs_lib.PDFWorker({ name: "thumbnails" });
  }
  return shared_worker;
}

// Pide un trozo del PDF al servidor; devuelve los bytes y el tamaño total del archivo
async function fetch_range(pdf_url, first_byte, last_byte, signal) {
  const response = await fetch(`/api/pdf?${new URLSearchParams({ url: pdf_url })}`, {
    headers: { Range: `bytes=${first_byte}-${last_byte}` },
    signal,
  });
  if (response.status !== 206) {
    let message = `server responded with status ${response.status}`;
    try {
      const data = await response.json();
      if (data.error) {
        message = data.error;
      }
    } catch (error) {
      console.warn(`Could not read the error body: ${error.message}`);
    }
    throw new Error(message);
  }
  const content_range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get("content-range") || "");
  let total_bytes = null;
  if (content_range !== null && content_range[3] !== "*") {
    total_bytes = Number(content_range[3]);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, total_bytes };
}

// Pone un texto de estado dentro del recuadro de la miniatura
function show_state(container, text, state_class) {
  const state = document.createElement("span");
  state.className = `sv_thumb_state ${state_class}`;
  state.textContent = text;
  container.replaceChildren(state);
}

// =============================================
// Rendering
// ---------------------------------------------

// Dibuja la primera página en un lienzo leyendo solo los trozos del PDF que hacen falta
async function draw_first_page(container, pdf_url, controller) {
  // 1. Primer trozo: trae el tamaño total, que pdf.js necesita para pedir el resto
  const first_chunk = await fetch_range(pdf_url, 0, RANGE_CHUNK_BYTES - 1, controller.signal);
  if (first_chunk.total_bytes === null) {
    throw new Error("the source does not report the file size");
  }
  if (!container.isConnected) {
    return null;
  }

  // 2. pdf.js pide los demás trozos por este transporte
  const pdfjs_lib = await load_pdfjs();
  const transport = new pdfjs_lib.PDFDataRangeTransport(first_chunk.total_bytes, first_chunk.bytes);
  transport.requestDataRange = (begin, end) => {
    fetch_range(pdf_url, begin, end - 1, controller.signal)
      .then((chunk) => {
        transport.onDataRange(begin, chunk.bytes);
      })
      .catch((error) => {
        // Sin ese trozo pdf.js se quedaría esperando: se cancela toda la miniatura
        console.warn(`Thumbnail range failed: ${error.message}`);
        controller.abort();
      });
  };
  const loading_task = pdfjs_lib.getDocument({
    range: transport,
    worker: get_worker(pdfjs_lib),
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: RANGE_CHUNK_BYTES,
    verbosity: 0,
  });

  // 3. Dibujar la página 1 al ancho de la miniatura
  try {
    const pdf_document = await loading_task.promise;
    const page = await pdf_document.getPage(1);
    const base_viewport = page.getViewport({ scale: 1 });
    const pixel_ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    const wanted_scale = (THUMBNAIL_WIDTH_CSS_PX * pixel_ratio) / base_viewport.width;
    const max_scale = Math.sqrt(MAX_CANVAS_PIXELS / (base_viewport.width * base_viewport.height));
    const viewport = page.getViewport({ scale: Math.min(wanted_scale, max_scale) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport }).promise;
    return canvas;
  } finally {
    try {
      await loading_task.destroy();
    } catch (error) {
      console.warn(`Could not release the PDF: ${error.message}`);
    }
  }
}

// Genera la miniatura de un recuadro; si algo falla muestra "no preview" y sigue con las demás
async function render_thumbnail(container) {
  const pdf_url = thumbnail_urls.get(container);
  const controller = new AbortController();
  const timeout_id = setTimeout(() => {
    controller.abort();
  }, THUMBNAIL_TIMEOUT_MS);

  // Si se cancela (o se agota el tiempo) la espera termina con error
  const aborted = new Promise((resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new Error("the thumbnail request failed or timed out"));
    }, { once: true });
  });

  try {
    const canvas = await Promise.race([draw_first_page(container, pdf_url, controller), aborted]);
    if (canvas === null || !container.isConnected) {
      return;
    }
    container.replaceChildren(canvas);
    container.classList.add("is_ready");
  } catch (error) {
    console.warn(`No thumbnail for ${pdf_url}: ${error.message}`);
    if (container.isConnected) {
      show_state(container, "no preview", "is_failed");
    }
  } finally {
    clearTimeout(timeout_id);
  }
}

// Atiende la cola: nunca más de MAX_CONCURRENT_THUMBNAILS a la vez
function run_queue() {
  while (active_jobs < MAX_CONCURRENT_THUMBNAILS && pending_containers.length > 0) {
    const container = pending_containers.shift();
    // Si la carta ya no está en la página (hubo otra búsqueda), se salta
    if (!container.isConnected) {
      continue;
    }
    active_jobs += 1;
    render_thumbnail(container).finally(() => {
      active_jobs -= 1;
      run_queue();
    });
  }
}

// Crea el observador la primera vez; encola cada recuadro cuando está por entrar en pantalla
function get_observer() {
  if (visibility_observer === null) {
    visibility_observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visibility_observer.unobserve(entry.target);
          pending_containers.push(entry.target);
        }
      }
      run_queue();
    }, { rootMargin: VISIBILITY_MARGIN });
  }
  return visibility_observer;
}

// =============================================
// Public API
// ---------------------------------------------

// Muestra el texto de espera y pide la miniatura de la primera página cuando el recuadro se acerque a la pantalla
export function observe_thumbnail(container, pdf_url) {
  thumbnail_urls.set(container, pdf_url);
  show_state(container, "pdf", "is_waiting");
  get_observer().observe(container);
}

// Olvida las miniaturas pendientes (por ejemplo, al empezar otra búsqueda)
export function clear_thumbnails() {
  pending_containers.length = 0;
  if (visibility_observer !== null) {
    visibility_observer.disconnect();
  }
}
