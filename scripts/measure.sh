#!/usr/bin/env bash
# Medição de escalabilidade do worker. Uso: ./scripts/measure.sh N_WORKERS
set -euo pipefail
cd "$(dirname "$0")/.."

N="${1:-1}"
JBS=6
API="http://localhost:3000"
FX=/tmp/opencode/fixtures

# ajusta o número de consumidores na fila (contagem efetiva no RabbitMQ)
for i in $(seq 1 60); do
  C=$(curl -s -u guest:guest http://localhost:15672/api/queues | python3 -c "import sys,json;print([q.get('consumers',0) for q in json.load(sys.stdin) if q['name']=='media.convert'][0])")
  [ "$C" = "$N" ] && break
  docker compose up -d --scale worker="$N" worker >/dev/null 2>&1
  sleep 2
done
echo "consumers=$C (esperado $N)"

# arquivos de carga: 6 vídeos de 30 s (720x480, h264)
if [ ! -f "$FX/cargo-1.mp4" ]; then
  mkdir -p "$FX"
  docker exec mediaconverter-worker-1 sh -c '
    for i in 1 2 3 4 5 6; do
      ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=720x480:rate=24:duration=30 \
        -f lavfi -i sine=duration=30 \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a libmp3lame \
        -movflags +faststart -f mp4 -y /tmp/cargo-$i.mp4
    done; tar -cf - -C /tmp cargo-1.mp4 cargo-2.mp4 cargo-3.mp4 cargo-4.mp4 cargo-5.mp4 cargo-6.mp4' > /tmp/opencode/cargo.tar
  tar -xf /tmp/opencode/cargo.tar -C "$FX"
fi

# submete os jobs e mede o tempo total (último POST → todos CONCLUÍDO)
declare -a IDS=()
T0=$(date +%s.%N)
for i in $(seq 1 $JBS); do
  ID=$(curl -s --max-time 60 -X POST "$API/jobs" -F "file=@$FX/cargo-$i.mp4" -F "targetFormat=avi" -F "notifyEmail=benchmark@local.dev" | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")
  IDS+=("$ID")
done
while true; do
  ALL=CONCLUÍDO
  for ID in "${IDS[@]}"; do
    S=$(curl -s "$API/jobs/$ID" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
    if [ "$S" != "CONCLUÍDO" ]; then ALL="$S"; break; fi
  done
  if [ "$ALL" = "CONCLUÍDO" ] || [ "$ALL" = "ERRO" ]; then break; fi
  sleep 0.5
done
T1=$(date +%s.%N)
D=$(python3 -c "print(f'{$T1-$T0:.1f}')")
echo "workers=$N jobs=$JBS tempo_total=${D}s estado_final=${ALL}"
