# Seraphim Vision - Documentación técnica

## Objetivo

Buscador gratuito de PDFs en la web, equivalente al operador `filetype:pdf` de Google, sin depender de APIs de pago.

## Arquitectura

```
                     Contenedor Docker (Render, plan free)
                    +------------------------------------------------+
Navegador  ->  :PORT | server.js (Node)  ->  127.0.0.1:8080 SearXNG    | ->  Brave, Google, Bing, DuckDuckGo...
                    |       |                                        |
                    +-------|----------------------------------------+
                            +-> verificación de cada enlace (HEAD / GET parcial)
```

## Despliegue

- **Imagen**: `Dockerfile` parte de la imagen oficial `searxng/searxng:latest` (Void Linux, glibc 2.41) y le copia el binario de Node desde `node:22-bookworm-slim`. La imagen de SearXNG no trae gestor de paquetes, por eso se copia el binario en lugar de instalarlo.
- **Arranque** (`docker/start.sh`):
  1. Lanza SearXNG con su entrypoint original, escuchando solo en `127.0.0.1:8080` (`GRANIAN_HOST`).
  2. Espera a que responda `/healthz`.
  3. Arranca Node en `PORT` (10000 por defecto, el puerto que usa Render).

  Si cualquiera de los dos procesos muere, el contenedor termina para que Render lo reinicie. `SIGTERM` detiene ambos de forma limpia.
- **Render**: `render.yaml` define un servicio web gratuito con Docker, health check en `/healthz` y `SEARXNG_SECRET` generado por Render.
- **Recursos medidos**: unos 140 MB de RAM con el contenedor limitado a 512 MB; SearXNG tarda unos 3 s en arrancar; una búsqueda con verificación tarda entre 7 y 13 s.

- **Frontend** (`src/`): HTML, CSS y JavaScript sin frameworks. Pinta los resultados con `createElement` y `textContent` (nunca `innerHTML`), así que los títulos y fragmentos de páginas externas no pueden inyectar código.
- **Servidor** (`server.js`): usa solo la librería estándar de Node (`http`, `fs`, `dns`, `fetch`). Sirve los archivos estáticos y expone dos endpoints.
- **SearXNG**: metabuscador de código abierto que se aloja aparte. Se configura con `searxng/settings.yml`, que activa la salida JSON.

## Endpoints

### `GET /api/search?q=<texto>&page=<1-20>`

1. Quita los operadores `filetype:`, `mime:` y `ext:` que escriba el usuario.
2. Consulta SearXNG en paralelo, una vez por cada grupo de motores (`ENGINE_GROUPS` en `server.js`), con el operador que entiende ese grupo:

   | Grupo | Operador |
   | --- | --- |
   | `brave`, `google cse`, `duckduckgo` | `filetype:pdf` |
   | `yandex` | `mime:pdf` |

   Si un grupo falla, sus motores aparecen en `unresponsive_engines` y la búsqueda sigue con los demás. Solo si fallan todos se devuelve error.
3. Junta los resultados y elimina las URLs duplicadas.
4. Verifica cada candidato en paralelo:
   - `HEAD`: si responde `200` con `content-type: application/pdf`, se acepta.
   - Si no es concluyente, hace un `GET` con `Range: bytes=0-1023` y busca la firma `%PDF-`.
5. Devuelve solo los PDFs verificados.

Respuesta:

```json
{
  "query": "machine learning",
  "page": 1,
  "results": [{ "title": "", "url": "", "domain": "", "snippet": "", "engines": [], "size_bytes": 13264 }],
  "candidates": 5,
  "rejected": 3,
  "has_more": true,
  "unresponsive_engines": [{ "name": "google", "error": "CAPTCHA" }],
  "cached": false
}
```

`has_more` es verdadero mientras SearXNG devuelva candidatos (hasta la página 20). Una página puede traer 0 PDFs verificados y aun así tener más páginas.

### Caché

El servidor guarda en memoria dos tipos de datos:

| Caché | Clave | Duración | Máximo |
| --- | --- | --- | --- |
| Búsquedas | consulta limpia en minúsculas + página | 60 min (`SEARCH_CACHE_TTL_MINUTES`); 10 min si el resultado es pobre | 500 entradas |
| Verificación de PDFs | URL | 6 h si es PDF, 30 min si no lo es | 5000 entradas |

- **Clave de búsqueda**: se le quitan los operadores y se normalizan espacios y mayúsculas, así que "Linear  Algebra", "linear algebra" y "linear algebra filetype:doc" comparten caché. `cached: true` en la respuesta indica que vino de la caché, y la interfaz lo muestra como "(cached)".
- **Resultado pobre**: falló un grupo de motores completo o no hubo candidatos. Se guarda menos tiempo para no conservarlo una hora.
- **Búsquedas simultáneas**: si llegan dos iguales a la vez, comparten la misma consulta a SearXNG (`searches_in_flight`).
- **Expiración**: al llenarse, se descarta la entrada usada hace más tiempo (un `Map` reordenado en cada lectura).
- **Sin persistencia**: la caché se pierde cuando el proceso se reinicia o Render duerme el servicio. `SEARCH_CACHE_TTL_MINUTES=0` desactiva la caché de búsquedas.

### `GET /api/download?url=<url>`

Descarga el PDF desde el origen y lo reenvía con `Content-Disposition: attachment`. Hace falta porque el atributo `download` de HTML no funciona con URLs de otro dominio. Antes de enviar nada, comprueba la firma `%PDF-` del archivo.

## Seguridad

- **SSRF**: el servidor visita URLs que vienen de resultados de búsqueda, así que antes de cada petición, y en cada redirección, valida que:
  - el protocolo sea `http` o `https`;
  - el host no sea `localhost`, `*.local` ni `*.internal`;
  - ninguna IP resuelta sea privada, de loopback o reservada (IPv4 e IPv6).

  Las redirecciones se siguen a mano (máximo 5) para validar cada salto.
- **Riesgo conocido**: entre la validación DNS y la conexión real puede ocurrir un DNS rebinding. Es aceptable para uso personal; para un despliegue público habría que fijar la IP resuelta en la conexión.
- **XSS**: el frontend no usa `innerHTML` y solo enlaza URLs `http(s)`.
- **Path traversal**: los archivos estáticos se resuelven dentro de `src/`; cualquier otra ruta responde 403.

## Configuración (`.env`)

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `PORT` | `3000` | Puerto del servidor Node |
| `SEARXNG_URL` | `http://localhost:8888` | URL base de SearXNG |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` o `error` |
| `TRUST_PROXY` | `false` (`true` en Docker) | Toma la IP del cliente de `X-Forwarded-For` |
| `SEARCH_LIMIT_PER_MINUTE` | `20` | Búsquedas por IP y minuto |
| `DOWNLOAD_LIMIT_PER_MINUTE` | `10` | Descargas por IP y minuto |
| `MAX_DOWNLOAD_BYTES` | `52428800` (50 MB) | Tamaño máximo que reenvía `/api/download` |
| `SEARCH_CACHE_TTL_MINUTES` | `60` | Duración de la caché de búsquedas; `0` la desactiva |
| `SEARXNG_SECRET` | sin valor por defecto | Clave de SearXNG; el contenedor no arranca sin ella |

El límite por IP usa el primer valor de `X-Forwarded-For`. Un cliente puede falsificarlo para saltarse el límite; es una protección básica contra abuso, no una defensa fuerte.

## Limitaciones

- **Bloqueos por CAPTCHA**: los motores (sobre todo Google) bloquean las IPs de centros de datos. Si SearXNG corre en la nube, Google suele fallar y quedan Bing, DuckDuckGo y otros. La interfaz avisa qué motores no respondieron.
- **Lentitud**: verificar enlaces suma entre 1 y 6 segundos por página (`VERIFY_TIMEOUT_MS`).
- **Bloqueos de bots**: algunos sitios bloquean peticiones que no vienen de un navegador; esos PDFs se descartan aunque existan.

## Decision Log

### 2026-11-14 - Caché en memoria para búsquedas y verificaciones

- Se eligió una caché en memoria dentro de `server.js` porque no necesita dependencias ni servicios extra.
- **Descartado por ahora**: Redis/Valkey. Sobrevive a que Render duerma el servicio, pero añade un servicio y una librería cliente.
- Se guardan también las verificaciones por URL, porque verificar es lo más lento y distintas búsquedas devuelven los mismos PDFs.
- **Medido con SearXNG simulado:**
  - una búsqueda repetida responde en menos de 10 ms;
  - una búsqueda nueva con PDFs ya verificados baja de 1 s a 0,3 s;
  - dos búsquedas iguales simultáneas generan una sola consulta.

### 2026-11-14 - Más motores: Yandex con mime:pdf

- En producción solo respondía Brave: en esta versión de SearXNG, Google y Bing vienen desactivados, y Startpage y Mojeek inactivos.
- Prueba motor por motor con `filetype:pdf` desde una IP residencial:
  - **Brave y Google CSE**: 19 de 20 resultados eran PDF.
  - **DuckDuckGo**: 10 de 10 cuando no pide CAPTCHA.
  - **Bing**: ignora `filetype:`, `ext:` y la palabra `pdf`; 0 PDFs.
  - **Yandex**: con `filetype:` dio 2 de 15 PDFs; con `mime:pdf`, 15 de 15.
  - **Google (scraping directo), Qwant, Mojeek, Startpage, Yahoo y Yep**: bloquean a SearXNG ("access denied", CAPTCHA o error HTTP).
- **Decisión:** dos grupos de motores en paralelo, cada uno con su operador. Se activó solo Yandex en `settings.yml`. Bing y los motores bloqueados no se activaron, porque solo sumarían enlaces descartados, avisos y tiempos de espera.
- **Resultado medido:** de 37 a 45 PDFs verificados por búsqueda (antes unos 27), en 6 a 10 s.

### 2026-11-14 - Despliegue en Render con un solo contenedor

- **Render (plan free) con Docker.**
  - GitHub Pages no sirve: solo publica páginas estáticas.
  - Koyeb, Hugging Face Spaces y Fly.io ya no tienen opciones gratuitas equivalentes.
- **Node y SearXNG en el mismo contenedor.** Si SearXNG se publicara solo con la salida JSON activa, cualquiera podría usarlo y la IP terminaría bloqueada. Así solo se expone el servidor Node.
- **Límite por IP y tope de descarga** (50 MB), porque el plan gratuito tiene poco tráfico mensual.
- **Motores eliminados**: Wikipedia, Wikidata, OpenStreetMap, Ahmia y Torch. No devuelven PDFs y fallaban al arrancar sin configuración extra.
- **`searxng/searxng:latest` sin fijar versión**, porque SearXNG corrige motores bloqueados con frecuencia. Cada despliegue toma la versión más reciente.

### 2026-11-14 - Pivote a buscador de PDFs con SearXNG

- Se eliminaron por completo las búsquedas de YouTube (YouTube Data API) y de películas (Watchmode), incluidas sus claves de API, que estaban escritas en el código. Esas claves siguen en el historial de git y deben revocarse.
- **Fuente de resultados: SearXNG propio.** Se descartaron:
  - Google Custom Search JSON API: cerrada a clientes nuevos, se apaga el 1 de enero de 2027.
  - Brave Search API: ya no tiene capa gratuita sin tarjeta.
  - Scraping directo de DuckDuckGo: frágil y contrario a sus términos de uso.
- **Servidor Node sin dependencias**: hace falta para evitar CORS, verificar los PDFs y forzar descargas. Se usa solo la librería estándar para no añadir paquetes.
- **Verificación obligatoria** de cada resultado (HEAD y, si no basta, la firma `%PDF-`), a cambio de unos segundos más por búsqueda.
- **Interfaz en inglés**, siguiendo la convención de que toda la salida del programa vaya en inglés.
- El CSS se reescribió desde cero (de unas 2300 líneas con bloques duplicados a unas 300), manteniendo la paleta oscura original.
