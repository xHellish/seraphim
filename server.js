// =============================================
// Imports
// ---------------------------------------------

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// =============================================
// Configuration
// ---------------------------------------------

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT_DIR, ".env");

// Cargar .env si existe (Node 20.12+ / 22)
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const PORT = Number(process.env.PORT || "3000");
const SEARXNG_URL = (process.env.SEARXNG_URL || "http://localhost:8888").replace(/\/+$/, "");
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
// En Render la IP real llega en X-Forwarded-For
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES || String(50 * 1024 * 1024));
const SEARCH_LIMIT_PER_MINUTE = Number(process.env.SEARCH_LIMIT_PER_MINUTE || "20");
const DOWNLOAD_LIMIT_PER_MINUTE = Number(process.env.DOWNLOAD_LIMIT_PER_MINUTE || "10");
const PREVIEW_LIMIT_PER_MINUTE = Number(process.env.PREVIEW_LIMIT_PER_MINUTE || "20");
const RATE_LIMIT_WINDOW_MS = 60000;
const SEARCH_CACHE_TTL_MINUTES = Number(process.env.SEARCH_CACHE_TTL_MINUTES || "60");

const STATIC_DIR = path.join(ROOT_DIR, "src");
const MAX_QUERY_LENGTH = 200;
const MAX_PAGE = 20;
const MAX_REDIRECTS = 5;
const SEARCH_TIMEOUT_MS = 20000;
const VERIFY_TIMEOUT_MS = 6000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const PDF_SNIFF_BYTES = 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; SeraphimVision/1.0; PDF search)";

// Grupos de motores y el operador de PDF que entiende cada uno
const ENGINE_GROUPS = [
  { engines: "brave,google cse,duckduckgo", pdf_operator: "filetype:pdf" },
  { engines: "yandex", pdf_operator: "mime:pdf" },
];

// Caché en memoria (se pierde si el proceso se reinicia o Render lo duerme)
const MINUTE_MS = 60 * 1000;
const SEARCH_CACHE_TTL_MS = SEARCH_CACHE_TTL_MINUTES * MINUTE_MS;
const DEGRADED_SEARCH_CACHE_TTL_MS = 10 * MINUTE_MS;
const SEARCH_CACHE_MAX_ENTRIES = 500;
const VERIFY_CACHE_PDF_TTL_MS = 6 * 60 * MINUTE_MS;
const VERIFY_CACHE_NOT_PDF_TTL_MS = 30 * MINUTE_MS;
const VERIFY_CACHE_MAX_ENTRIES = 5000;

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
};

// =============================================
// Logging
// ---------------------------------------------

// Escribe un log si su nivel supera LOG_LEVEL
function log(level, message) {
  const min_level = LOG_LEVELS[LOG_LEVEL] || LOG_LEVELS.info;
  if (LOG_LEVELS[level] < min_level) {
    return;
  }
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// =============================================
// HTTP helpers
// ---------------------------------------------

// Responde con un cuerpo JSON
function send_json(res, status_code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status_code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

// Clase de error con código HTTP para responder al cliente
class HttpError extends Error {
  constructor(status_code, message) {
    super(message);
    this.status_code = status_code;
  }
}

// =============================================
// Rate limiting (ventana fija por IP, en memoria)
// ---------------------------------------------

const rate_limit_buckets = new Map();

// Obtiene la IP del cliente, usando X-Forwarded-For solo detrás de un proxy
function get_client_ip(req) {
  if (TRUST_PROXY) {
    const forwarded_for = req.headers["x-forwarded-for"];
    if (typeof forwarded_for === "string" && forwarded_for.trim() !== "") {
      return forwarded_for.split(",")[0].trim();
    }
  }
  return req.socket.remoteAddress || "unknown";
}

// Lanza 429 si la IP superó el límite de la ventana actual
function enforce_rate_limit(req, bucket_name, limit_per_window) {
  const key = `${bucket_name}:${get_client_ip(req)}`;
  const now = Date.now();
  let bucket = rate_limit_buckets.get(key);

  // Abrir una ventana nueva si no existe o ya venció
  if (bucket === undefined || now - bucket.window_start >= RATE_LIMIT_WINDOW_MS) {
    bucket = { window_start: now, count: 0 };
    rate_limit_buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit_per_window) {
    throw new HttpError(429, `Too many ${bucket_name} requests; try again in a minute`);
  }
}

// Limpia ventanas vencidas para no acumular memoria
const rate_limit_cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rate_limit_buckets.entries()) {
    if (now - bucket.window_start >= RATE_LIMIT_WINDOW_MS) {
      rate_limit_buckets.delete(key);
    }
  }
}, RATE_LIMIT_WINDOW_MS);
rate_limit_cleanup.unref();

// =============================================
// In-memory cache (expiración + límite de tamaño, se descarta lo más antiguo)
// ---------------------------------------------

// Crea una caché vacía; Map conserva el orden de inserción
function create_cache(max_entries) {
  return { entries: new Map(), max_entries };
}

// Devuelve el valor guardado o undefined si no existe o venció
function cache_get(cache, key) {
  const entry = cache.entries.get(key);
  if (entry === undefined) {
    return undefined;
  }
  if (Date.now() >= entry.expires_at) {
    cache.entries.delete(key);
    return undefined;
  }
  // Mover al final para que sea el último en descartarse
  cache.entries.delete(key);
  cache.entries.set(key, entry);
  return entry.value;
}

// Guarda un valor con su tiempo de vida y descarta los más antiguos si sobra
function cache_set(cache, key, value, ttl_ms) {
  cache.entries.delete(key);
  cache.entries.set(key, { value, expires_at: Date.now() + ttl_ms });
  while (cache.entries.size > cache.max_entries) {
    const oldest_key = cache.entries.keys().next().value;
    cache.entries.delete(oldest_key);
  }
}

const search_cache = create_cache(SEARCH_CACHE_MAX_ENTRIES);
const verify_cache = create_cache(VERIFY_CACHE_MAX_ENTRIES);
// Búsquedas en curso, para que dos peticiones iguales compartan el trabajo
const searches_in_flight = new Map();

// =============================================
// URL safety (evita que el servidor consulte la red interna)
// ---------------------------------------------

// Devuelve true si la IP es privada, de loopback o reservada
function is_private_ip(address) {
  let ip = address.toLowerCase();

  // IPv4 mapeada en IPv6 (::ffff:10.0.0.1)
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) {
    ip = ip.slice(7);
  }

  if (isIP(ip) === 4) {
    const parts = ip.split(".");
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    if (first === 0 || first === 10 || first === 127 || first >= 224) {
      return true;
    }
    if (first === 169 && second === 254) {
      return true;
    }
    if (first === 172 && second >= 16 && second <= 31) {
      return true;
    }
    if (first === 192 && second === 168) {
      return true;
    }
    if (first === 100 && second >= 64 && second <= 127) {
      return true;
    }
    return false;
  }

  if (isIP(ip) === 6) {
    if (ip === "::" || ip === "::1") {
      return true;
    }
    if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) {
      return true;
    }
    return false;
  }

  throw new Error(`Not an IP address: ${address}`);
}

// Lanza un error si la URL no es http(s) pública
async function assert_public_url(raw_url) {
  // 1. Validar formato y protocolo
  let parsed_url;
  try {
    parsed_url = new URL(raw_url);
  } catch (error) {
    throw new HttpError(400, `Invalid URL: ${raw_url} (${error.message})`);
  }
  if (parsed_url.protocol !== "http:" && parsed_url.protocol !== "https:") {
    throw new HttpError(400, `Unsupported URL protocol: ${parsed_url.protocol}`);
  }

  // 2. Rechazar nombres locales
  let hostname = parsed_url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new HttpError(403, `Blocked local hostname: ${hostname}`);
  }

  // 3. Resolver DNS y rechazar IPs privadas
  let addresses;
  if (isIP(hostname) !== 0) {
    addresses = [{ address: hostname }];
  } else {
    addresses = await lookup(hostname, { all: true });
  }
  for (const entry of addresses) {
    if (is_private_ip(entry.address)) {
      throw new HttpError(403, `Blocked private address for ${hostname}: ${entry.address}`);
    }
  }
  return parsed_url;
}

// fetch que sigue redirecciones a mano, validando cada salto
async function fetch_public(start_url, options) {
  let current_url = start_url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assert_public_url(current_url);
    const response = await fetch(current_url, { ...options, redirect: "manual" });

    // Respuesta final
    if (response.status < 300 || response.status >= 400) {
      return { response, final_url: current_url };
    }

    // Redirección: liberar el cuerpo y saltar a la nueva URL
    const location = response.headers.get("location");
    if (response.body !== null) {
      await response.body.cancel();
    }
    if (location === null) {
      throw new Error(`Redirect without location header from ${current_url}`);
    }
    current_url = new URL(location, current_url).href;
  }
  throw new Error(`Too many redirects starting at ${start_url}`);
}

// =============================================
// PDF verification
// ---------------------------------------------

// Devuelve true si el content-type indica PDF
function is_pdf_content_type(content_type) {
  if (content_type === null) {
    return false;
  }
  return content_type.toLowerCase().includes("application/pdf");
}

// Convierte una cabecera numérica a entero o null
function parse_size(header_value) {
  if (header_value === null) {
    return null;
  }
  // content-range: "bytes 0-1023/123456"
  const slash_index = header_value.lastIndexOf("/");
  let raw_value = header_value;
  if (slash_index !== -1) {
    raw_value = header_value.slice(slash_index + 1);
  }
  const size = Number(raw_value);
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return size;
}

// Lee los primeros bytes de un cuerpo y cancela el resto
async function read_first_bytes(response, byte_limit) {
  const chunks = [];
  let total_length = 0;
  const reader = response.body.getReader();
  while (total_length < byte_limit) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total_length += value.length;
  }
  await reader.cancel();
  return Buffer.concat(chunks);
}

// Devuelve true si el buffer contiene la firma %PDF- al inicio
function has_pdf_signature(buffer) {
  return buffer.subarray(0, PDF_SNIFF_BYTES).toString("latin1").includes("%PDF-");
}

// Comprueba si una URL sirve de verdad un PDF
async function verify_pdf(url) {
  const headers = { "user-agent": USER_AGENT };

  // 1. Intento rápido con HEAD
  try {
    const head = await fetch_public(url, { method: "HEAD", headers, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    if (head.response.ok && is_pdf_content_type(head.response.headers.get("content-type"))) {
      return { is_pdf: true, size_bytes: parse_size(head.response.headers.get("content-length")), reason: "content-type" };
    }
    log("debug", `HEAD not conclusive for ${url}: status ${head.response.status}, type ${head.response.headers.get("content-type")}`);
  } catch (error) {
    if (error instanceof HttpError) {
      return { is_pdf: false, size_bytes: null, reason: error.message };
    }
    log("debug", `HEAD failed for ${url}: ${error.message}`);
  }

  // 2. GET parcial para leer la firma del archivo
  try {
    const get = await fetch_public(url, {
      method: "GET",
      headers: { ...headers, range: `bytes=0-${PDF_SNIFF_BYTES - 1}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!get.response.ok) {
      if (get.response.body !== null) {
        await get.response.body.cancel();
      }
      return { is_pdf: false, size_bytes: null, reason: `HTTP ${get.response.status}` };
    }
    let size_bytes = parse_size(get.response.headers.get("content-range"));
    if (size_bytes === null) {
      size_bytes = parse_size(get.response.headers.get("content-length"));
    }
    const first_bytes = await read_first_bytes(get.response, PDF_SNIFF_BYTES);
    if (has_pdf_signature(first_bytes)) {
      return { is_pdf: true, size_bytes, reason: "signature" };
    }
    return { is_pdf: false, size_bytes: null, reason: `not a PDF (${get.response.headers.get("content-type")})` };
  } catch (error) {
    return { is_pdf: false, size_bytes: null, reason: error.message };
  }
}

// Igual que verify_pdf, pero reutiliza resultados recientes de la misma URL
async function verify_pdf_cached(url) {
  const cached = cache_get(verify_cache, url);
  if (cached !== undefined) {
    return cached;
  }
  const verification = await verify_pdf(url);
  if (verification.is_pdf) {
    cache_set(verify_cache, url, verification, VERIFY_CACHE_PDF_TTL_MS);
  } else {
    cache_set(verify_cache, url, verification, VERIFY_CACHE_NOT_PDF_TTL_MS);
  }
  return verification;
}

// =============================================
// SearXNG search
// ---------------------------------------------

// Quita operadores de tipo de archivo que escriba el usuario
function clean_user_query(query) {
  const clean_query = query.replace(/\b(filetype|mime|ext):\S+/gi, " ").replace(/\s+/g, " ").trim();
  if (clean_query === "") {
    throw new HttpError(400, "Query must contain search terms besides filetype:");
  }
  return clean_query;
}

// Pide una página de resultados a SearXNG para un grupo de motores
async function fetch_searxng_results(clean_query, page, engine_group) {
  const params = new URLSearchParams({
    q: `${clean_query} ${engine_group.pdf_operator}`,
    format: "json",
    pageno: String(page),
    engines: engine_group.engines,
    safesearch: "0",
  });
  const search_url = `${SEARXNG_URL}/search?${params}`;

  let response;
  try {
    // SearXNG espera X-Real-IP; la petición sale del propio servidor
    response = await fetch(search_url, {
      headers: { "x-real-ip": "127.0.0.1" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HttpError(502, `Could not reach SearXNG at ${SEARXNG_URL}: ${error.message}`);
  }
  if (response.status === 403) {
    throw new HttpError(502, "SearXNG rejected the JSON format; enable 'json' in search.formats of settings.yml");
  }
  if (!response.ok) {
    throw new HttpError(502, `SearXNG responded with status ${response.status}`);
  }
  return response.json();
}

// Busca PDFs, elimina duplicados y verifica cada enlace (sin caché de búsqueda)
async function run_pdf_search(clean_query, page) {
  // 1. Consultar SearXNG con cada grupo de motores en paralelo
  const group_requests = [];
  for (const engine_group of ENGINE_GROUPS) {
    group_requests.push(fetch_searxng_results(clean_query, page, engine_group));
  }
  const group_outcomes = await Promise.allSettled(group_requests);

  // Juntar resultados; si un grupo falla, se reporta y se sigue con los demás
  const raw_results = [];
  const unresponsive_engines = [];
  let first_error = null;
  let failed_groups = 0;
  for (const [index, outcome] of group_outcomes.entries()) {
    if (outcome.status === "rejected") {
      log("warn", `Engine group "${ENGINE_GROUPS[index].engines}" failed: ${outcome.reason.message}`);
      unresponsive_engines.push({ name: ENGINE_GROUPS[index].engines, error: outcome.reason.message });
      failed_groups += 1;
      if (first_error === null) {
        first_error = outcome.reason;
      }
      continue;
    }
    for (const result of outcome.value.results || []) {
      raw_results.push(result);
    }
    for (const entry of outcome.value.unresponsive_engines || []) {
      unresponsive_engines.push({ name: entry[0], error: entry[1] });
    }
  }
  // Si fallaron todos los grupos, devolver el error (por ejemplo SearXNG caído)
  if (failed_groups === ENGINE_GROUPS.length) {
    throw first_error;
  }

  // 2. Quitar duplicados por URL
  const seen_urls = new Set();
  const candidates = [];
  for (const result of raw_results) {
    if (typeof result.url !== "string" || seen_urls.has(result.url)) {
      continue;
    }
    seen_urls.add(result.url);
    candidates.push(result);
  }

  // 3. Verificar todos los candidatos en paralelo
  const verifications = [];
  for (const candidate of candidates) {
    verifications.push(verify_pdf_cached(candidate.url));
  }
  const verification_results = await Promise.all(verifications);

  // 4. Armar la respuesta solo con PDFs verificados
  const results = [];
  for (const [index, candidate] of candidates.entries()) {
    const verification = verification_results[index];
    if (!verification.is_pdf) {
      log("debug", `Discarded ${candidate.url}: ${verification.reason}`);
      continue;
    }
    results.push({
      title: candidate.title || "",
      url: candidate.url,
      domain: new URL(candidate.url).hostname,
      snippet: candidate.content || "",
      engines: candidate.engines || [],
      size_bytes: verification.size_bytes,
      // Falso si el PDF supera el tope que reenvía el servidor (preview y descarga)
      previewable: verification.size_bytes === null || verification.size_bytes <= MAX_DOWNLOAD_BYTES,
    });
  }

  log("info", `Search "${clean_query}" page ${page}: ${candidates.length} candidates, ${results.length} verified PDFs`);
  return {
    body: {
      page,
      results,
      candidates: candidates.length,
      rejected: candidates.length - results.length,
      has_more: candidates.length > 0 && page < MAX_PAGE,
      unresponsive_engines,
    },
    // Resultado pobre: falló un grupo entero o no hubo candidatos
    is_degraded: failed_groups > 0 || candidates.length === 0,
  };
}

// Busca PDFs usando la caché; búsquedas iguales en curso comparten el trabajo
async function search_pdfs(query, page) {
  // 1. Clave normalizada: sin operadores, espacios simples y minúsculas
  const clean_query = clean_user_query(query);
  const cache_key = `${clean_query.toLowerCase()}|${page}`;

  // 2. Respuesta guardada
  const cached_body = cache_get(search_cache, cache_key);
  if (cached_body !== undefined) {
    log("info", `Cache hit for "${clean_query}" page ${page}`);
    return { ...cached_body, query, cached: true };
  }

  // 3. Misma búsqueda ya en curso: esperar su resultado
  let search_promise = searches_in_flight.get(cache_key);
  if (search_promise === undefined) {
    search_promise = run_pdf_search(clean_query, page);
    searches_in_flight.set(cache_key, search_promise);
  }

  try {
    // 4. Buscar y guardar (menos tiempo si el resultado es pobre)
    const outcome = await search_promise;
    let ttl_ms = SEARCH_CACHE_TTL_MS;
    if (outcome.is_degraded) {
      ttl_ms = Math.min(SEARCH_CACHE_TTL_MS, DEGRADED_SEARCH_CACHE_TTL_MS);
    }
    if (ttl_ms > 0) {
      cache_set(search_cache, cache_key, outcome.body, ttl_ms);
    }
    return { ...outcome.body, query, cached: false };
  } finally {
    searches_in_flight.delete(cache_key);
  }
}

// =============================================
// Route handlers
// ---------------------------------------------

// GET /api/search?q=...&page=...
async function handle_search(res, request_url) {
  // 1. Validar parámetros
  const query = (request_url.searchParams.get("q") || "").trim();
  if (query === "") {
    throw new HttpError(400, "Missing query parameter 'q'");
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new HttpError(400, `Query is longer than ${MAX_QUERY_LENGTH} characters`);
  }
  const page = Number(request_url.searchParams.get("page") || "1");
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    throw new HttpError(400, `Parameter 'page' must be an integer between 1 and ${MAX_PAGE}`);
  }

  // 2. Buscar y responder
  const body = await search_pdfs(query, page);
  send_json(res, 200, body);
}

// Genera un nombre de archivo seguro a partir de la URL
function build_download_filename(final_url) {
  const last_segment = decodeURIComponent(new URL(final_url).pathname.split("/").pop() || "");
  let filename = last_segment.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  if (filename === "" || filename === "_") {
    filename = "document";
  }
  if (!filename.toLowerCase().endsWith(".pdf")) {
    filename = `${filename}.pdf`;
  }
  return filename;
}

// Espera a que el socket acepte más datos
function wait_for_drain(res) {
  return new Promise((resolve) => {
    res.once("drain", resolve);
  });
}

// Reenvía un PDF de otro sitio; disposition es "attachment" (descarga) o "inline" (preview)
async function handle_download(req, res, request_url, disposition) {
  // 1. Validar parámetro
  const target_url = request_url.searchParams.get("url");
  if (target_url === null || target_url === "") {
    throw new HttpError(400, "Missing query parameter 'url'");
  }

  // 2. Descargar del origen (validando cada redirección)
  const { response, final_url } = await fetch_public(target_url, {
    method: "GET",
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    if (response.body !== null) {
      await response.body.cancel();
    }
    throw new HttpError(502, `Source responded with status ${response.status}`);
  }
  const content_length = response.headers.get("content-length");
  if (content_length !== null && Number(content_length) > MAX_DOWNLOAD_BYTES) {
    await response.body.cancel();
    throw new HttpError(413, `PDF is larger than the ${Math.round(MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB download limit; open it directly instead`);
  }

  // 3. Leer el inicio y confirmar que es un PDF
  const reader = response.body.getReader();
  const head_chunks = [];
  let head_length = 0;
  let stream_done = false;
  while (head_length < PDF_SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      stream_done = true;
      break;
    }
    head_chunks.push(value);
    head_length += value.length;
  }
  const head_buffer = Buffer.concat(head_chunks);
  if (!has_pdf_signature(head_buffer)) {
    await reader.cancel();
    throw new HttpError(422, "The source did not return a PDF file");
  }

  // 4. Enviar cabeceras y el contenido en streaming
  const response_headers = {
    "content-type": "application/pdf",
    "content-disposition": `${disposition}; filename="${build_download_filename(final_url)}"`,
    // El archivo se sirve desde nuestro origen: nunca debe interpretarse como otro tipo
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
  if (content_length !== null) {
    response_headers["content-length"] = content_length;
  }
  res.writeHead(200, response_headers);
  res.write(head_buffer);
  let sent_bytes = head_buffer.length;

  // Cancelar la descarga de origen si el cliente se va
  req.on("close", () => {
    if (!res.writableEnded) {
      reader.cancel().catch((error) => {
        log("warn", `Could not cancel source stream: ${error.message}`);
      });
    }
  });

  while (!stream_done) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    // Cortar si el origen no declaró tamaño y supera el límite
    sent_bytes += value.length;
    if (sent_bytes > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error(`Download of ${final_url} exceeded ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    if (!res.write(value)) {
      await wait_for_drain(res);
    }
  }
  res.end();
  log("info", `Forwarded (${disposition}) ${final_url}`);
}

// Sirve archivos estáticos desde src/
async function serve_static(res, pathname) {
  // 1. Resolver la ruta sin salir de STATIC_DIR
  let relative_path;
  try {
    relative_path = decodeURIComponent(pathname);
  } catch (error) {
    throw new HttpError(400, `Malformed path: ${pathname} (${error.message})`);
  }
  if (relative_path === "/") {
    relative_path = "/index.html";
  }
  const file_path = path.normalize(path.join(STATIC_DIR, relative_path));
  if (!file_path.startsWith(STATIC_DIR + path.sep)) {
    throw new HttpError(403, "Forbidden path");
  }

  // 2. Leer y enviar el archivo
  let content;
  try {
    content = await readFile(file_path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      throw new HttpError(404, `Not found: ${pathname}`);
    }
    throw error;
  }
  const content_type = MIME_TYPES[path.extname(file_path).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "content-type": content_type, "content-length": content.length });
  res.end(content);
}

// Enruta cada petición
async function handle_request(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, `Method not allowed: ${req.method}`);
  }
  const request_url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (request_url.pathname === "/healthz") {
    send_json(res, 200, { status: "ok" });
    return;
  }
  if (request_url.pathname === "/api/search") {
    enforce_rate_limit(req, "search", SEARCH_LIMIT_PER_MINUTE);
    await handle_search(res, request_url);
    return;
  }
  if (request_url.pathname === "/api/download") {
    enforce_rate_limit(req, "download", DOWNLOAD_LIMIT_PER_MINUTE);
    await handle_download(req, res, request_url, "attachment");
    return;
  }
  if (request_url.pathname === "/api/preview") {
    enforce_rate_limit(req, "preview", PREVIEW_LIMIT_PER_MINUTE);
    await handle_download(req, res, request_url, "inline");
    return;
  }
  await serve_static(res, request_url.pathname);
}

// =============================================
// Server
// ---------------------------------------------

const server = createServer((req, res) => {
  handle_request(req, res).catch((error) => {
    // Errores esperados: responder con su código
    let status_code = 500;
    if (error instanceof HttpError) {
      status_code = error.status_code;
      log("warn", `${req.method} ${req.url} -> ${status_code}: ${error.message}`);
    } else {
      log("error", `${req.method} ${req.url} failed: ${error.stack || error.message}`);
    }

    // Si ya se enviaron cabeceras (descarga a medias), cortar la conexión
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    let message = "Internal server error";
    if (error instanceof HttpError) {
      message = error.message;
    }
    send_json(res, status_code, { error: message });
  });
});

server.listen(PORT, () => {
  log("info", `Seraphim Vision running at http://localhost:${PORT} (SearXNG: ${SEARXNG_URL})`);
});
