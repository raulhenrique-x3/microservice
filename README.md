# Conversor Escalável de Vídeo, Áudio e Imagem

Projeto acadêmico: conversão de mídia com **microserviços reais** — API, Worker e Notifier são processos **independentes** (imagem, banco e deploy próprios), coordenados exclusivamente por eventos no RabbitMQ. Processamento assíncrono, escala horizontal de workers, notificação por e-mail e armazenamento S3-compatível — tudo orquestrado por `docker compose up --build`.

```
Frontend (React) ──HTTP multipart──▶ API ──outbox──▶ RabbitMQ ──▶ Worker ×N ──▶ MinIO (FFmpeg/Sharp)
                                      │ ▲                    │ started/               │
                                      │ └── eventos de status │ completed/              └── evento ✅ ──▶ Notifier ──▶ SMTP (Mailpit)
                                      │       (job_views)     │ failed
                                  PostgreSQL              dead-letter
                             (db da API) ─ … ─ (db do Worker) ─ (db do Notifier)
```

## Serviços

| Serviço | Papel | Imagem | Banco (dono) | Porta (host) |
|---|---|---|---|---|
| `frontend` | upload + acompanhamento do pedido | build `front-end/` | — | 5173 |
| `api` | `POST /jobs` (202 + jobId), `GET /jobs/:jobId` (status via projeção de eventos) | `mediaconverter-api` | `converter_api` (jobs, outbox, job_views) | 3000 |
| `worker` (×N) | claim → conversão → upload → eventos de status | `mediaconverter-worker` | `converter_worker` (processing_jobs, outbox) | — |
| `notifier` | dedupe próprio → link pré-assinado → e-mail | `mediaconverter-notifier` | `converter_notifier` (notified_jobs) | — |
| `postgres` | **um database por serviço** (database-per-service) | — | — | 5434 |
| `rabbitmq` | filas `media.convert` / eventos topic `media.events` / DLQ `media.dead` | — | — | 5672 / **15672 (UI)** |
| `minio` | buckets `uploads` (dono: api) e `converted` (dono: worker) | — | — | 9000 / **9001 (UI)** |
| `storage` | bootstrap: buckets + **usuário S3 com policy mínima por serviço** | — | — | — |
| `mailpit` | SMTP fake + caixa de entrada | — | — | 1025 / **8025 (UI)** |

> **Nota sobre MinIO:** as imagens oficiais do MinIO foram retiradas de todos os registros públicos em 09/2026. O projeto usa `pgsty/silo` — fork binário-compatível com MinIO CE (mesma API S3, mesmo `mc`, mesmas variáveis de ambiente). Para trocar por MinIO real, basta ajustar `image:` no `docker-compose.yml`.

## Separação de microserviços (o que é dessacoplado)

- **Banco de dados por serviço**: cada serviço possui suas tabelas (`prisma/schema.prisma` próprio, migrations próprias). Nenhum serviço lê ou escreve no banco do outro.
- **Estado transmitido por eventos**: o worker publica `CONVERSION_STARTED`/`CONVERSION_COMPLETED`/`CONVERSION_FAILED`; a API mantém um *read model* (`job_views`) alimentado por esses eventos (event-carried state transfer). O status final é **eventualmente consistente** — entre o worker concluir e o evento chegar, `GET` mostra o estado anterior.
- **Código separado**: `services/apps/{api,worker,notifier}` + `docker/{api,worker,notifier}.Dockerfile` — três imagens, builds e deploys independentes. O único artefato compartilhado é `packages/shared` (contratos de eventos + adapters de infra: RabbitMQ/S3), tratado como lib.
- **Least privilege no MinIO**: usuário S3 por serviço — `api` escreve em `uploads` e lê `converted`; `worker` lê/remove `uploads` e escreve `converted`; `notifier` apenas lê `converted` (presign). Policies em `docker/storage/`.
- **Dedupe por evento no notifier**: tabela própria `notified_jobs` (claim atômico por insert) substitui o `notifiedAt` que antes era coluna da tabela alheia; idem para as tentativas do worker (`processing_jobs`).

O front-end não mudou: continua falando HTTP com a API (que atua como gateway da fachada).

## Execução

```bash
cp .env.example .env      # credenciais locais (nunca use fora de dev)
docker compose up --build # primeira vez: cria os 3 databases via init script
```

> **Upgrade de um compose anterior**: os volumes antigos (`pgdata`, `rabbitmq`) têm schema/topologia desatualizados. Rode `docker compose down -v` uma vez antes do `up` (apaga estado local de dev).

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
cd services
npm test              # testes unit (contratos de eventos, magic bytes, validações)
npm run test:e2e      # integrados (exige stack do compose no ar)
```

Cobertura dos integrados: validação e criação; conversão ponta a ponta (png→jpeg) com verificação do resultado (magic bytes JPEG), do objeto no bucket `converted`, da remoção do original e do banco **de cada serviço**; idempotência de mensagem repetida (nada reprocessado); idempotência de notificação (evento duplicado → 1 e-mail); mensagens inválidas e job fantasma → DLQ; falha permanente → 3 tentativas → `ERRO` (escrita pelo dono: worker), original preservado e sem e-mail.

## Fluxo de mensagens (resumo)

1. `POST /jobs` → valida arquivo/usuário (magic bytes) → sobe original para `uploads/{uuid}/original.{fmt}` → **mesma transação** cria o job `PENDING` e a mensagem de outbox → resposta `202 {jobId}`.
2. O relay de outbox **da API** (a cada 1,5 s) publica `CONVERSION_REQUESTED` na fila (at-least-once; consumidores idempotentes).
3. Worker: faz **claim na própria tabela** (`processing_jobs`) e publica `STARTED`; download, conversão, upload em `converted/{jobId}/result.{fmt}`; transação no banco **do worker** marca `DONE` + evento de conclusão na outbox; só então remove o original; `ack`.
4. Falhas: até `MAX_ATTEMPTS` (3) reentregas com backoff de 2 s; na última, `ERRORED` no banco do worker + evento `FAILED` + mensagem invalidada para a DLQ (original preservado).
5. A API consome `started`/`completed`/`failed` (fila `media.projection`) e aplica transições **guardadas por estado** (nada regredido por duplicidade).
6. Notifier: consome `completed` (fila `media.notifications`), faz claim atômico em `notified_jobs` (evita duplicidade), presigna URL (30 min) e envia o e-mail.

Certificados de entrega, diagramas e roteiro de demonstração: [`docs/architecture.md`](docs/architecture.md), [`docs/report.md`](docs/report.md), [`docs/demo.md`](docs/demo.md). *(docs da fase monolito: revisar para a nova topologia.)*

## Variáveis de ambiente

Ver `.env.example`. Principais: `DATABASE_URL` (**da API**; worker/notifier têm as suas no compose: `converter_worker`/`converter_notifier`), `RABBITMQ_URL`, `MINIO_*` (`MINIO_ENDPOINT` para operações dentro da rede, `MINIO_PRESIGN_HOST` para URLs que o navegador abre; `MINIO_ACCESS_KEY/SECRET` **por serviço** no compose), `MAX_UPLOAD_MB` (padrão 200), `MAX_ATTEMPTS` (3), `PRESIGN_EXPIRY_SECONDS` (1800), `SMTP_HOST/PORT`, `VITE_API_URL`.

## Limpa tudo

```bash
docker compose down -v   # remove volumes também
```
