#!/bin/sh
# =============================================
# Arranque del contenedor: SearXNG interno + servidor Node
# ---------------------------------------------
set -u

SEARXNG_HEALTH_URL="http://127.0.0.1:8080/healthz"
STARTUP_TIMEOUT_SECONDS=90

# Detiene ambos procesos al recibir la señal de apagado
shutdown() {
  echo "Stopping Seraphim Vision..."
  kill "$SEARXNG_PID" "$NODE_PID" 2>/dev/null
  wait
  exit 0
}

if [ -z "${SEARXNG_SECRET:-}" ]; then
  echo "ERROR: SEARXNG_SECRET is not set; SearXNG refuses to start without it" >&2
  exit 1
fi

# 1. SearXNG con su entrypoint original (necesita su carpeta como cwd)
NODE_PID=""
cd /usr/local/searxng
/usr/local/searxng/entrypoint.sh &
SEARXNG_PID=$!
trap shutdown TERM INT

# 2. Esperar a que SearXNG responda
elapsed=0
until wget -q -O /dev/null --header "X-Real-IP: 127.0.0.1" "$SEARXNG_HEALTH_URL"; do
  if ! kill -0 "$SEARXNG_PID" 2>/dev/null; then
    echo "ERROR: SearXNG exited during startup" >&2
    exit 1
  fi
  if [ "$elapsed" -ge "$STARTUP_TIMEOUT_SECONDS" ]; then
    echo "ERROR: SearXNG did not respond after $STARTUP_TIMEOUT_SECONDS seconds" >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
echo "SearXNG ready after $elapsed seconds"

# 3. Servidor Node
cd /app
node /app/server.js &
NODE_PID=$!

# 4. Si cualquiera de los dos muere, cerrar el contenedor para que se reinicie
while kill -0 "$SEARXNG_PID" 2>/dev/null && kill -0 "$NODE_PID" 2>/dev/null; do
  sleep 5
done
echo "ERROR: a process exited unexpectedly; stopping container" >&2
kill "$SEARXNG_PID" "$NODE_PID" 2>/dev/null
exit 1
