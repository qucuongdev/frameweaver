#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "========================================================"
echo "  FrameWeaver Backend dang khoi dong..."
echo "  API Server: http://127.0.0.1:8100"
echo "  Swagger UI: http://127.0.0.1:8100/docs"
echo "  Extension WS: ws://127.0.0.1:9222"
echo "========================================================"
echo ""

echo "Kiem tra va giai phong cong 8100, 9222 neu bi chiem..."
for port in 8100 9222; do
  pids=$(netstat -ano 2>/dev/null | grep ":$port " | grep "LISTENING" | awk '{print $5}' | sort -u)
  for pid in $pids; do
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      echo "Tat tien trinh cu chiem cong $port (PID: $pid)..."
      taskkill //f //pid $pid 2>/dev/null || true
    fi
  done
done

echo ""
echo "Dang khoi dong Backend FastAPI & WebSocket..."
./.venv/Scripts/python.exe -m agent.main
