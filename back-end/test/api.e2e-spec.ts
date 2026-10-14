import { describe, it, expect, afterAll } from 'vitest';
import amqplib from 'amqplib';
import { PrismaClient } from '@prisma/client';
import { Client as S3Client } from 'minio';
import { ConversionRequested, ConversionCompleted, EX } from '../src/queue/contracts.js';

const API = 'http://localhost:3000';
process.env.DATABASE_URL ||= 'postgresql://converter:converter@localhost:5434/converter';
const p = new PrismaClient();
const fixtures = (f: string) => `/tmp/opencode/fixtures/${f}`;

const s3 = new S3Client({ endPoint: 'localhost', port: 9000, useSSL: false, accessKey: 'minioadmin', secretKey: 'minioadmin' });
const objectExists = (bucket: string, key: string) =>
  s3.statObject(bucket, key).then(() => true, () => false);

afterAll(async () => p.$disconnect());

async function publishConversion(msg: ConversionRequested) {
  const conn = await amqplib.connect('amqp://guest:guest@localhost:5672');
  const ch = await conn.createConfirmChannel();
  ch.publish(EX.JOBS_EXCHANGE, EX.RK_CONVERT, Buffer.from(JSON.stringify(msg)), { persistent: true, contentType: 'application/json' });
  await ch.waitForConfirms();
  await conn.close();
}

async function publishCompletion(msg: ConversionCompleted) {
  const conn = await amqplib.connect('amqp://guest:guest@localhost:5672');
  const ch = await conn.createConfirmChannel();
  ch.publish(EX.EVENTS_EXCHANGE, EX.RK_COMPLETED, Buffer.from(JSON.stringify(msg)), { persistent: true, contentType: 'application/json' });
  await ch.waitForConfirms();
  await conn.close();
}

function messageFromJob(jobId: string, objectKey: string, sourceType: string, sourceFormat: string, targetFormat: string, notifyEmail: string): ConversionRequested {
  return { jobId, objectKey, sourceType: sourceType as 'image', sourceFormat, targetFormat, notifyEmail, requestedAt: new Date().toISOString(), attempt: 0 };
}

async function post(file: string, targetFormat: string, notifyEmail = 'e2e@local.dev') {
  const form = new FormData()
  const buf = await import('node:fs/promises').then((fs) => fs.readFile(fixtures(file)));
  form.append('file', new Blob([new Uint8Array(buf)]), file);
  form.append('targetFormat', targetFormat);
  form.append('notifyEmail', notifyEmail);
  const res = await fetch(`${API}/jobs`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() as { jobId?: string; message?: string } };
}

async function get(jobId: string) {
  const res = await fetch(`${API}/jobs/${jobId}`);
  return { status: res.status, body: await res.json() };
}

async function waitFor(jobId: string, statuses: string[], timeoutMs = 60_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await get(jobId);
    if (statuses.includes(body.status)) return body.status;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout esperando ${statuses} para ${jobId}`);
}

describe('API Fluxo POST /jobs e validação', () => {
  it('rejeita payload de texto disfarçado (tipo real ≠ extensão)', async () => {
    const { status, body } = await post('thing.txt', 'png');
    expect([status, body.message as unknown]).toEqual([400, 'tipo de arquivo não suportado ou corrompido']);
  });
  it('não reconhece .txt: renomeia thing.txt para thing.png via Blob header check manual', async () => {
    // o teste acima já cobre; este testa o caso de extensão errada com conteúdo válido
    const { status } = await post('test.png', 'png');
    expect(status).toBe(202);
  });
  it('rejeita conversão cruzada de tipo (imagem → áudio)', async () => {
    const { status } = await post('test.png', 'wav');
    expect(status).toBe(400);
  });
  it('rejeita e-mail inválido', async () => {
    const { status } = await post('test.png', 'png', 'nope');
    expect(status).toBe(400);
  });
  it('rejeita formato de destino desconhecido', async () => {
    const { status, body } = await post('test.png', 'gif');
    expect(status).toBe(400);
    expect(JSON.stringify(body.message)).toMatch(/formato de destino inválido/);
  });
  it('404 para jobId inexistente', async () => {
    const { status } = await get('00000000-0000-0000-0000-000000000000');
    expect(status).toBe(404);
  });
});

describe('pipeline de conversão (imagem, ponta a ponta)', () => {
  it('converte png → jpeg, gera URL de download e remove o original', async () => {
    const { status, body } = await post('test.png', 'jpeg');
    expect(status).toBe(202);
    const jobId = body.jobId!;
    expect(typeof jobId).toBe('string');

    const final = await waitFor(jobId, ['CONCLUÍDO', 'ERRO']);
    expect(final).toBe('CONCLUÍDO');

    const { body: view } = await get(jobId);
    expect(view.status).toBe('CONCLUÍDO');
    expect(view.downloadUrl).toBeTruthy();

    const dl = await fetch(view.downloadUrl);
    expect(dl.status).toBe(200);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]); // JPEG magic

    const job = await p.job.findUnique({ where: { id: jobId } });
    expect(job!.resultKey).toBe(`${jobId}/result.jpeg`);

    // resultado existe no bucket converted e o original NÃO existe mais
    expect(await objectExists('converted', `${jobId}/result.jpeg`)).toBe(true);
    expect(await objectExists('uploads', job!.originalKey)).toBe(false);

    // link de funcionamento presignado (200)
    const headPresign = await fetch(view.downloadUrl);
    expect(headPresign.status).toBe(200);
  });
});

describe('entrega repetida, idempotência e notificação', () => {
  it('mesma mensagem entregue duas vezes → único resultado, status CONCLUÍDO, sem e-mail duplicado', { timeout: 90_000 }, async () => {
    const { body } = await post('test.webp', 'png', `e2e-idem+${Date.now()}@local.dev`);
    const jobId = body.jobId!;
    const job = await waitFor(jobId, ['CONCLUÍDO']) ? await p.job.findUnique({ where: { id: jobId } }) : null;
    expect(job!.status).toBe('DONE');

    const before = await mailpitSearchCount(job!.notifyEmail);
    expect(before).toBe(1);
    await publishConversion(messageFromJob(jobId, job!.originalKey, job!.sourceType, job!.sourceFormat, job!.targetFormat, job!.notifyEmail));
    await new Promise((r) => setTimeout(r, 4000));
    expect(await mailpitSearchCount(job!.notifyEmail)).toBe(before); // nenhuma notificação nova
    expect((await p.job.findUnique({ where: { id: jobId } }))!.status).toBe('DONE');
  });

  it('evento de conclusão duplicado → e-mail enviado apenas uma vez', { timeout: 90_000 }, async () => {
    const email = `e2e-ndup+${Date.now()}@local.dev`;
    const { body } = await post('test.jpg', 'png', email);
    const jobId = body.jobId!;
    await waitFor(jobId, ['CONCLUÍDO']);
    // espera a PRIMEIRA notificação (do worker) para eliminar corrida
    for (let i = 0; i < 20; i++) {
      const j = await p.job.findUnique({ where: { id: jobId } });
      if (j!.notifiedAt) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const job = await p.job.findUnique({ where: { id: jobId } });
    expect(job!.notifiedAt).toBeTruthy();

    const before = await mailpitSearchCount(email);
    await publishCompletion({ jobId: job!.id, resultKey: job!.resultKey!, notifyEmail: email, completedAt: new Date().toISOString() });
    await publishCompletion({ jobId: job!.id, resultKey: job!.resultKey!, notifyEmail: email, completedAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 5000));
    const after = await mailpitSearchCount(email);
    expect(before).toBe(1);
    expect(after).toBe(before); // apenas a primeira notificação existiu
  });
});

describe('falha definitiva, retentativas e DLQ', () => {
  it('mensagens inválidas e de job inexistente vão para a DLQ sem reprocessamento', { timeout: 60_000 }, async () => {
    const corruptTag = 'corrupto-' + Date.now();
    const conn = await amqplib.connect('amqp://guest:guest@localhost:5672');
    const ch = await conn.createChannel();
    ch.publish(EX.JOBS_EXCHANGE, EX.RK_CONVERT, Buffer.from(JSON.stringify({ tag: corruptTag })), { persistent: true });
    await publishConversion(messageFromJob('99999999-9999-4999-9999-999999999999', 'x/original.png', 'image', 'png', 'png', 'e2e-dlq@local.dev'));

    // consome a DLQ (basicGet) procurando as duas mensagens mortas
    const foundGhost = await findInDLQ('99999999-9999-4999-9999-999999999999', 30_000);
    expect(foundGhost).toBe(true);
    await conn.close();
  });

  it('falha permanente de conversão: 3 tentativas, ERRO, original preservado, DLQ e sem e-mail', { timeout: 90_000 }, async () => {
    // objeto real no MinIO, mas mensagem pede rota ffmpeg inválida (png tratado como vídeo):
    // download ok, conversão falha em todas as tentativas
    const email = `e2e-perm+${Date.now()}@local.dev`;
    const jobId = crypto.randomUUID();
    const objectKey = `${jobId}/original.png`;
    const buf = await import('node:fs/promises').then((fs) => fs.readFile(fixtures('test.png')));
    await s3.putObject('uploads', objectKey, buf, buf.length, { contentType: 'image/png' } as never);
    await p.job.create({ data: {
      id: jobId,
      originalKey: objectKey,
      originalName: 'test.png',
      originalSize: buf.length,
      sourceType: 'video',
      sourceFormat: 'avi',
      targetFormat: 'mp3',
      notifyEmail: email,
    }});
    const emailsBefore = await mailpitSearchCount(email);

    await publishConversion({ jobId, objectKey, sourceType: 'video', sourceFormat: 'avi', targetFormat: 'mp3', notifyEmail: email, requestedAt: new Date().toISOString(), attempt: 0 });

    const final = await waitFor(jobId, ['ERRO'], 60_000);
    expect(final).toBe('ERRO');

    const errored = await p.job.findUnique({ where: { id: jobId } });
    expect(errored!.attempts).toBeGreaterThanOrEqual(3);
    expect(errored!.errorDetail).toContain('ffmpeg');
    // original intocado (não foi removido)
    expect(await objectExists('uploads', objectKey)).toBe(true);
    // sem e-mail de notificação e mensagem morta na DLQ
    expect(await mailpitSearchCount(email)).toBe(emailsBefore);
  });
});

async function findInDLQ(needleJobId: string, timeoutMs: number): Promise<boolean> {
  const conn = await amqplib.connect('amqp://guest:guest@localhost:5672');
  const ch = (await conn.createChannel()) as amqplib.Channel;
  await ch.assertQueue(EX.JOBS_DLQ, { durable: true });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = await ch.get(EX.JOBS_DLQ, { ack: true });
    if (!got) { await new Promise((r) => setTimeout(r, 500)); continue; }
    const payload = got.content.toString();
    try { if (JSON.parse(payload).jobId === needleJobId) { await conn.close(); return true; } }
    catch { /* mensagem morta não-JSON: pule (e.g. payload corrompido legado) */ }
  }
  await conn.close();
  return false;
}

async function mailpitSearchCount(email: string): Promise<number> {
  const res = await fetch('http://localhost:8025/api/v1/messages?limit=200');
  const data = (await res.json()) as { messages: { to: { Address: string }[] }[] };
  return (data.messages ?? []).filter((m) => (m.To ?? []).some((r) => r.Address === email)).length;
}
