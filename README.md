# Seraphim Vision (beta)

Seraphim Vision is a free PDF search engine for the web. It works like the classic Google `filetype:pdf` operator: you type a topic and it returns only links that really serve a PDF file.

Results come from [SearXNG](https://github.com/searxng/searxng), a free, open source metasearch engine. Seraphim Vision queries Brave, Google CSE, DuckDuckGo (with `filetype:pdf`) and Yandex (with `mime:pdf`) in parallel. A small Node.js server forces `filetype:pdf`, checks every link and discards anything that is not a real PDF. Both run inside a single Docker container, so SearXNG is never exposed to the internet.

## Features

- Web-wide PDF search through SearXNG, with no paid API keys
- Every result is verified (HTTP headers or the `%PDF-` file signature)
- First-page thumbnail on every result (rendered in the browser with pdf.js, only when the card scrolls into view), open the PDF at the source or download it
- Pagination with "Load more"
- Warning when a search engine is blocked (for example by a CAPTCHA)
- In-memory cache: repeated searches answer instantly and known PDFs are not re-checked
- Per-IP rate limiting and a download size limit
- Pixel art interface in the AXM style (circuit board background, framed cards, CRT status terminal)
- Shareable search URLs (`/?q=...`) with working back and forward navigation
- Responsive design

## Deploy on Render (free)

1. Push this repository to GitHub (it can be private).
2. In [Render](https://render.com), choose **New > Blueprint** and select the repository.
3. Render reads `render.yaml`, creates the free web service and generates `SEARXNG_SECRET`.
4. Wait for the first build (a few minutes) and open the `.onrender.com` URL.

Free services sleep after about 15 minutes without traffic; the first request after that takes around a minute.

## Run locally with Docker

```bash
docker build -t seraphim-vision .
```

```bash
docker run --rm -p 127.0.0.1:10000:10000 -e SEARXNG_SECRET=change-me-to-a-long-random-string seraphim-vision
```

Open `http://localhost:10000`.

## Run locally without Docker

Requires Node.js 20.12+ and a SearXNG instance with JSON output enabled (see `searxng/settings.yml`). Create a `.env` file in the project root (optional, these are the defaults):

```
PORT=3000
SEARXNG_URL=http://localhost:8888
LOG_LEVEL=info
```

```bash
npm start
```

## Project structure

```
server.js              Node server: static files, /api/search, /api/download, /api/pdf, /healthz
src/                   Search page (index.html, scripts/app.js, scripts/thumbnails.js, styles/main.css)
src/vendor/pdfjs       pdf.js 6.5.438 (Apache 2.0), copied from the pdfjs-dist package
src/css, src/js        AXM style kit (axm.css, axm.js), copied unchanged
src/assets             BitPap font, circuit backgrounds, cursors and logo
searxng/settings.yml   SearXNG configuration (JSON output, unused engines removed)
Dockerfile             Official SearXNG image + Node binary
docker/start.sh        Starts SearXNG (internal) and then the Node server
render.yaml            Render Blueprint (free Docker web service)
```

See `Documentation.md` for architecture and technical decisions.

Contributions are welcome! Please feel free to submit a pull request or open an issue.
