# Relatório técnico

*Conversor escalável de vídeo, áudio e imagem — arquitetura assíncrona com RabbitMQ*

## 1. Justificativa do RabbitMQ

A conversão de mídia é CPU-intensiva e lenta (segundos a minutos). Manter a requisição HTTP aberta até a conclusão desperdiça recursos e torna a API frágil. O RabbitMQ permite: (a) **desacoplamento espacial e temporal** — API aceita pedidos mesmo com todos os workers ocupados; (b) **escala horizontal natural** — observar a fila e dimensionar réplicas, sem alteração de código; (c) **durabilidade** — mensagens persistentes sobrevivem a reinícios; (d) **compartimentalização de falhas** — um worker morto não afeta a ingestão. A fila é do tipo *competing consumers*: a mesma fila `media.convert` é consumida por N workers com `prefetch=1`, distribuindo justamente a carga. Poderia ser Kafka, mas o domínio aqui é de filas de trabalho pontuais (job queue), não de fluxos de eventos de alta vazão — RabbitMQ entrega manual-ack e DLQ sem infraestrutura extra.

## 2. Garantias de entrega e idempotência

O sistema aceita **at-least-once** com efeitos idempotentes; **não** promete exactly-once — impossível de garantir entre broker, banco e conversores distribuídos, e o próprio RabbitMQ não garante execução única em reentregas:

- **Outbox transacional.** O ponto de maior risco é a janela entre gravar o job e publicar a mensagem. A mensagem nasce no outbox **na mesma transação** do job (Sequência em `docs/architecture.md`); um relay leve (1,5 s) publica as não enviadas e as marca. Consistência: sem job "perdido que ninguém sabia que existia". Duplicatas de publicação (crash entre *publish* e *mark*) são toleradas porque os consumidores são idempotentes.
- **Idempotência do worker.** A entrega repetida encontra o job já `CONCLUÍDO`/`ERRO` e apenas confirma (`ack`) sem reprocessar. O resultado é gravado em chave determinística `{jobId}/result.{fmt}`, tanto que reescrever é inofensivo.
- **Recovery de worker.** Um worker morto no meio da conversão deixa mensagem não-ack; o broker reentrega e outro worker recupera o job via claim `PENDENTE→PROCESSANDO` (condicional). Isso cobre o caso de defeito entre a gravação do banco e o `ack`.
- **DLQ.** Mensagens desapropriadas (payload inválido, `jobId` inexistente) e falhas definitivas após `MAX_ATTEMPTS=3` (backoff 2 s) vão para `media.dead` com o original preservado no bucket `uploads`.
- **Notificação.** O notifier faz *claim* condicional de `notifiedAt` (UPDATE ... WHERE notifiedAt IS NULL). Redelivery → `count=0` → `ack` sem reenvio. `shortcut`: crash do processo **exatamente** entre send e claim de erro continua podendo gerar 0 ou 1 duplicidade — janela mínima, impossível eliminar sem dedupe no SMTP; documentada como limitação conhecida.

## 3. Segurança e armazenamento

- Tipo real do arquivo por **magic bytes** (não extensão), whitelist (mp4/avi/wav/mp3/png/jpeg/webp) e compatibilidade origem→destino — `imagem → áudio/vídeo` rejeitada.
- Binário nunca trafega pelo broker (payload ~300 bytes).
- `FFmpeg` via `spawn` com argumentos **fixos** (nenhuma interpolação de entrada do usuário na linha de comando); Sharp identicamente delimitado.
- Buckets privados; resultados expostos só por **URL pré-assinada (30 min)** — nem a fila, nem o frontend tocam credenciais.
- Objetos com nomes gerados por UUID — sem caminho controlável pelo usuário.
- O original é removido **só após** a transação de conclusão; em falha definitiva permanece para diagnóstico.

## 4. Testes e medições de escalabilidade

21 testes: 10 unitários (detecção de tipo, regras de conversão, contratos) e 11 de integração (exigem o stack do compose: validação/upload, conversão ponta a ponta com verificação do formato do resultado, remoção do original, idempotência de mensagem e de notificação, DLQ e falha permanente). Resultados registrados por execução real, não por afirmação — nenhum teste declarado aprovado sem ter sido executado.

**Medição de escalabilidade.** Carga: 6 jobs (vídeos MP4 720×480, 30 s, ~1,3 MB) submetidos em rajada, transcodificação `mp4→avi`:

| Workers | Tempo total (s) |
|---|---|
| 1 | 6,3 |
| 2 | 4,0 |
| 3 | 3,8 |

Interpretação honesta: o ganho entre 1→2 é real (−37%); de 2→3 é pequeno porque cada conversão leva ~0,6 s e a carga tem só 6 itens — quando o primeiro worker ainda termina o job atual, os demais já esvaziam a fila. O ganho adicional depende da disponibilidade de CPU, da I/O do MinIO e do tamanho dos arquivos: com conversões de minutos, a vantagem se aproxima do linear até saturar a CPU. Medidas obtidas em ambiente de desenvolvimento local, em uma única máquina.

**Recuperação por interrupção (verificado ao vivo):** worker eliminado durante `PROCESSANDO`; mensagem não confirmada reentregada e concluída por outro worker (job `CONCLUÍDO`, original removido), sem duplicação de e-mail.

## 5. Limitações conhecidas

1. **Sem progresso real** — FFmpeg não reporta na fila contratual progresso de arquivo individuais; a interface exibe o estado na fila, sem barra.
2. **Memória** — arquivos inteiros em RAM (upload/conversão/download, teto `MAX_UPLOAD_MB=200`); streaming parcial requerer arquivo em disco persistente para casos além desse teto.
3. **URL pré-assinada expira (30 min)** — e-mail antigo morre após o prazo; regenerável via `GET /jobs`.
4. **Alta disponibilidade não abordada** — single banner Postgres/Rabbit/MinIO no compose; para produção de verdade exigiria quorum/replicação (ex.: RabbitMQ clustering), fora do escopo acadêmico.
5. **DLQ sem alarme** — fila verificada por inspeção via UI/API, sem monitoramento automático embutido.
6. **MinIO oficial indisponível** — as imagens oficiais foram removidas de todos os registros públicos em 09/2026; a imagem usada, `pgsty/silo`, é um fork binário-compatível (mesma API S3 e utilitário `mc`). Trocar para MinIO real é mudar a chave `image:` do compose.
7. **`CONCLUÍDO` sem checksum** — a verificação de resultados por testes fecha por formato e tamanho, não por hash de referência.
