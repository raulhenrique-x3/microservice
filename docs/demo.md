# Roteiro de demonstração (≤ 10 minutos)

Pré-requisito: `docker compose up --build` no ar com **3 réplicas de worker** (`docker compose up -d --scale worker=3`). Arquivos de apoio em `/tmp/opencode/fixtures` (gerados conforme §4). Todos os números abaixo foram **medidos** nesta máquina — repita os passos para reproduzir.

| Passo | Onde | O que seguir / comando | Tempo |
|---|---|---|---|
| 1. Upload + retorno imediato | Frontend <http://localhost:5173> | selecionar `video.mp4`, destino `AVI`, e-mail; enviar → `202 {jobId}` aparece de imediato | 0:30 |
| 2. Mensagem no painel | RabbitMQ UI <http://localhost:15672> (guest/guest) | fila **media.convert** pulsando, `consumers=3`, DLQ `media.dead` | 0:45 |
| 3. Três workers processando | RabbitMQ → *Queues* → `media.convert` | *Consumers: 3*; logs `docker logs -f mediaconverter-worker-2` mostram reivindicações concorrentes | 0:45 |
| 4. Resultado no MinIO | MinIO UI <http://localhost:9001> (minioadmin/minioadmin) | bucket **converted** → `{jobId}/result.avi` com magic bytes `(RIFF....AVI )` — `xxd -l 12` | 0:45 |
| 5. Original removido após sucesso | MinIO UI → bucket **uploads** | a chave do job concluído **não existe mais** | 0:30 |
| 6. E-mail no Mailpit | <http://localhost:8025> | mensagem de `conversor@local` com link assinado (expira em 30 min); abrir link → download | 1:00 |
| 7. Estados do pedido | Frontend (aba aberta) ou `curl -s localhost:3000/jobs/{jobId} | python3 -m json.tool` | evolui `PENDENTE → PROCESSANDO → CONCLUÍDO` (elemento da UI: chip colorido por estado) | 0:45 |
| 8. Worker derrubado no meio | terminal | script na §"Recuperação de crash" abaixo: matar um worker durante `PROCESSANDO` → outro worker conclui (`CONCLUÍDO`), sem duplicar e-mail | 2:00 |
| 9. Comparação 1/2/3 workers | terminal | `./scripts/measure.sh 1`, `2`, `3` (reexecuta com 6 jobs 720p); registrar os três tempos | 2:30 |

**Medições registradas nesta máquina** (6 jobs de 30 s, 720×480, MP4→AVI):

- **1 worker: 6,3 s** · **2 workers: 4,0 s** · **3 workers: 3,8 s**

Ganho 1→2: −37%. Ganho 2→3: marginal neste tamanho de carga (fila de 6 itens de ~0,6 s) — explicar que com arquivos maiores/concêntricos o speedup se aproxima do linear até a saturação de CPU. Não inventar número nenhum além dos medidos.

## Recuperação de crash (passo 8)

```bash
# submeter um vídeo grande (big.mp4, 60 s 720p)
JID=$(curl -s -X POST localhost:3000/jobs -F "file=@/tmp/opencode/fixtures/big.mp4" \
  -F "targetFormat=avi" -F "notifyEmail=demo@local.dev" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")

# no instante em que aparecer PROCESSANDO, matar o worker
for i in $(seq 1 60); do
  S=$(curl -s localhost:3000/jobs/$JID | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])" 2>/dev/null)
  [ "$S" = PROCESSANDO ] && docker stop -t 1 mediaconverter-worker-1 && break
  sleep 0.15
done

# resultado: mensagem reentregue, outro worker conclui
curl -s localhost:3000/jobs/$JID | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])"  # CONCLUÍDO
docker compose up -d --scale worker=3 worker   # repõe o worker derrubado
```

Exibição adicional (passo 2 do DLQ, 30 s): reenviar uma mensagem de job inexistente e apontar `media.dead` no RabbitMQ — verificação de que mensagens dignas de perda já não reprocessam.

## Números que **não** devem ser inventados

- Tempos de conversão dependem de CPU, edição do formato e concorrência local — medir antes de citar.
- O e-mail pode demorar alguns segundos (relay de eventos a cada 1,5 s).
- O link do Mailpit visita uma URL pré-assinada do MinIO; se expirou (30 min), gerar nova via `GET /jobs/:jobId`.
