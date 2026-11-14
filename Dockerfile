# =============================================
# Node runtime (solo se usa para copiar el binario)
# ---------------------------------------------
FROM docker.io/library/node:22-bookworm-slim AS node_runtime

# =============================================
# Imagen final: SearXNG oficial + servidor Node
# ---------------------------------------------
# Se usa "latest" a propósito: SearXNG corrige motores bloqueados con frecuencia
FROM docker.io/searxng/searxng:latest

# Binario de Node (la imagen de SearXNG trae glibc y libstdc++ compatibles)
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node

# Configuración de SearXNG (salida JSON activada)
COPY searxng/settings.yml /etc/searxng/settings.yml

# Aplicación
COPY package.json server.js /app/
COPY src /app/src
COPY docker/start.sh /usr/local/bin/start.sh
RUN chmod 755 /usr/local/bin/start.sh && node --version

# SearXNG solo escucha dentro del contenedor; Render publica el puerto de Node
ENV GRANIAN_HOST=127.0.0.1 \
    GRANIAN_PORT=8080 \
    SEARXNG_URL=http://127.0.0.1:8080 \
    TRUST_PROXY=true \
    PORT=10000 \
    LOG_LEVEL=info

EXPOSE 10000

ENTRYPOINT ["/usr/local/bin/start.sh"]
