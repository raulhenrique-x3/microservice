# Conversor Escalável de Vídeo, Áudio e Imagem

Projeto acadêmico: conversão de mídia com processamento **assíncrono** (fila), escala horizontal de workers, notificação por e-mail e armazenamento S3-compatível — tudo orquestrado por `docker compose up --build`.

```
Frontend (React) ──HTTP multipart──▶ API (NestJS) ──outbox──▶ RabbitMQ ──▶ Workers (NestJS, N réplicas)
                                        │                        │                    │
                                    PostgreSQL              dead-letter          MinIO + FFmpeg/Sharp
                                        │                                             │
                                        └──────────── Notifier (NestJS) ◀─────────────┘
                                                       │ SMTP (Mailpit)
```

## Componentes

| Serviço | Papel | Porta (host) |
|---|---|---|
| `frontend` | upload + acompanhamento do pedido | 5173 |
| `api` | `POST /jobs` (202 + jobId), `GET /jobs/:jobId` | 3000 |
| `worker` (×N) | download → conversão → upload → ack | — |
| `notifier` | e-mail com link do arquivo convertido | — |
| `postgres` | pedidos e outbox | 5434 |
| `rabbitmq` | fila `media.convert`, eventos, DLQ `media.dead` | 5672 / **15672 (UI)** |
| `minio` | buckets `uploads` e `converted` | 9000 / **9001 (UI)** |
| `mailpit` | SMTP fake + caixa de entrada | 1025 / **8025 (UI)** |

> **Nota sobre MinIO:** as imagens oficiais do MinIO foram retiradas de todos os registros públicos em 09/2026. O projeto usa `pgsty/silo` — fork binário-compatível com MinIO CE (mesma API S3, mesmo `mc`, mesmas variáveis de ambiente). Para trocar por MinIO real, basta ajustar `image:` no `docker-compose.yml`.

## Execução

```bash
cp .env.example .env      # credenciais locais (nunca use fora de dev)
docker compose up --build
```

- Frontend: <http://localhost:5173>
- API: <http://localhost:3000>
- RabbitMQ UI: <http://localhost:15672> (guest/guest)
- MinIO UI: <http://localhost:9001> (minioadmin/minioadmin)
- Mailpit: <http://localhost:8025>

Escalar workers (uma fila compartilhada, *competing consumers*):

```bash
docker compose up -d --scale worker=3   # sem mudar uma linha de código
```

Para checar o número efetivo de consumidores: `curl -su guest:guest http://localhost:15672/api/queues | python3 -c "import sys,json;print([(q['name'],q['consumers']) for q in json.load(sys.stdin)])"`

## Formatos aceitos

| Origem (detectada por *magic bytes*, não extensão) | Destinos |
|---|---|
| imagem (png, jpeg, webp) | png, jpeg, webp (Sharp) |
| vídeo (mp4, avi) | mp4, avi, wav, mp3 (FFmpeg; extrai áudio) |
| áudio (wav, mp3) | wav, mp3 (FFmpeg) |

Verificação por HTTP: `POST /jobs` com `targetFormat` inválido ou tipo cruzado (ex.: PNG → MP3) retorna `400`.

## Testes

```bash
cd back-end
npx vitest run                                  # 10 testes unit (sem stack)
npx vitest run --config ./vitest.config.e2e.ts  # 11 testes integrados (exige stack do compose no ar)
```

Cobertura dos integrados: validação e criação; conversão ponta a ponta (png→jpeg) com verificação do resultado (magic bytes JPEG), do objeto no bucket `converted` e da remoção do original; idempotência de mensagem repetida; idempotência de notificação (evento duplicado → 1 e-mail); mensagens inválidas e job inexistente → DLQ; falha permanente → 3 tentativas → `ERRO`, original preservado e sem e-mail.

## Fluxo de mensagens (resumo)

1. `POST /jobs` → valida arquivo/usuário → sobe original para `uploads` → **mesma transação** cria o job `PENDENTE` e a mensagem de outbox → resposta `202 {jobId}`.
2. Um *relay* de outbox em cada processo publica mensagens pendentes na fila (at-least-once; consumidores idempotentes por `jobId`).
3. Worker: claim `PENDENTE→PROCESSANDO`, download, conversão, upload em `converted/{jobId}/result.{fmt}`, transação `CONCLUÍDO` + evento de conclusão, **só então** remove o original, `ack`.
4. Falhas: até `MAX_ATTEMPTS` (3) reentregas com backoff de 2 s; na última, `ERRO` + original preservado + mensagem invalidada para a DLQ.
5. Notifier: consome eventos, *claim* condicional em `notifiedAt` (evita duplicidade), gera URL pré-assinada e envia e-mail.

Certificados de entrega, contratos pixel-precisos e diagramas: [`docs/architecture.md`](docs/architecture.md). Relatório técnico: [`docs/report.md`](docs/report.md). Roteiro de demonstração (≤10 min): [`docs/demo.md`](docs/demo.md).

## Variáveis de ambiente

Ver `.env.example`. Principais: `DATABASE_URL`, `RABBITMQ_URL`, `MINIO_*` (`MINIO_ENDPOINT` para operações dentro da rede, `MINIO_PRESIGN_HOST` para URLs que o navegador abre), `MAX_UPLOAD_MB` (padrão 200), `MAX_ATTEMPTS` (3), `PRESIGN_EXPIRY_SECONDS` (1800), `SMTP_HOST/PORT`, `VITE_API_URL`.

## Limpa tudo

```bash
docker compose down -v   # remove volumes também
```
