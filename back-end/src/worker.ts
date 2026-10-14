import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaService } from './services/prisma.service.js';
import { MinioService, BUCKETS } from './services/minio.service.js';
import { OutboxRelay } from './queue/outbox.js';
import { connectRabbit } from './queue/rabbit.js';
import { ConversionCompleted, ConversionRequested, EX, validateConversionRequested } from './queue/contracts.js';
import { convert } from './conversion/converters.js';
import { MIME_BY_FORMAT, wireStatus } from './media/media.js';

@Module({ providers: [PrismaService, MinioService, OutboxRelay], exports: [PrismaService, MinioService, OutboxRelay] })
export class WorkerModule {}

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);

export async function startWorker() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'warn', 'error'] });
  const prisma = app.get(PrismaService);
  const minio = app.get(MinioService);
  const outbox = app.get(OutboxRelay);
  await Promise.all([minio.ensureBucket(BUCKETS.upload), minio.ensureBucket(BUCKETS.converted)]);
  outbox.channel = await connectRabbit();

  outbox.channel!.consume(EX.JOBS_QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const r = await handleMessage(msg);
      if (r.ack && r.msg) outbox.channel!.ack(r.msg);
    } catch (e) {
      console.error('[worker] unexpected error:', e);
      await new Promise((r) => setTimeout(r, 2000)); // transient infra failure → requeue
      try { outbox.channel!.nack(msg, false, true); } catch {}
    }
  });
  console.log('[worker] consuming', EX.JOBS_QUEUE);

  async function handleMessage(msg: import('amqplib').ConsumeMessage | null): Promise<{ ack: boolean; msg: typeof msg }> {
    if (!msg) return { ack: false, msg };
    const log = (...a: unknown[]) => console.log('[worker]', ...a);

    // invalid message shape → definitive failure, straight to DLQ
    let payload: ConversionRequested;
    try {
      payload = validateConversionRequested(JSON.parse(msg.content.toString()));
    } catch (e) {
      log('invalid message, dead-lettering:', (e as Error).message);
      outbox.channel!.nack(msg, false, false);
      return { ack: false, msg: null };
    }

    const job = await prisma.job.findUnique({ where: { id: payload.jobId } });
    if (!job) {
      log('unknown job', payload.jobId, '→ DLQ');
      outbox.channel!.nack(msg, false, false);
      return { ack: false, msg: null };
    }
    // idempotency: already finalized by a previous delivery
    if (job.status === 'DONE' || job.status === 'ERRORED') {
      log('job', payload.jobId, `${wireStatus(job.status)} already finalized → ack (idempotent)`);
      return { ack: true, msg };
    }
    // claim so other workers skip this job; PROCESSING redelivery after a crash is reprocessed in place
    await prisma.job.updateMany({ where: { id: job.id, status: 'PENDING' }, data: { status: 'PROCESSING' } });
    if (job.status !== 'PROCESSING') log('claiming redelivered job', payload.jobId, 'after crash');

    try {
      const original = await minio.downloadUpload(payload.objectKey);
      const result = await convert(payload.sourceType as 'video' | 'audio' | 'image', payload.sourceFormat, payload.targetFormat, original);
      const resultKey = `${payload.jobId}/result.${payload.targetFormat}`;
      await minio.putResult(resultKey, result, MIME_BY_FORMAT[payload.targetFormat as keyof typeof MIME_BY_FORMAT]);

      await prisma.$transaction(async (tx) => {
        await tx.job.update({
          where: { id: job.id },
          data: { status: 'DONE', resultKey },
        });
        const completed: ConversionCompleted = {
          jobId: job.id,
          resultKey,
          notifyEmail: payload.notifyEmail,
          completedAt: new Date().toISOString(),
        };
        await tx.outbox.create({ data: { kind: 'CONVERSION_COMPLETED', payload: JSON.stringify(completed) } });
      });

      // only now is it safe to delete the original
      await minio.deleteUpload(payload.objectKey);
      log('job', payload.jobId, `→ CONCLUÍDO (${payload.sourceFormat} → ${payload.targetFormat})`);
      return { ack: true, msg };
    } catch (e) {
      const err = e as Error;
      const attempts = job.attempts + 1;
      log(`job ${payload.jobId} failed (attempt ${attempts}/${MAX_ATTEMPTS}):`, err.message);
      if (attempts >= MAX_ATTEMPTS) {
        await prisma.job.update({
          where: { id: job.id },
          data: { status: 'ERRORED', errorDetail: err.message.slice(0, 500), attempts },
        });
        outbox.channel!.nack(msg, false, false); // last attempt: DLQ, original preserved
        log('job', payload.jobId, '→ ERRO (definitive, original preserved, message in DLQ)');
        return { ack: false, msg: null };
      }
      await prisma.job.update({ where: { id: job.id }, data: { attempts } });
      await new Promise((r) => setTimeout(r, 2000)); // simple backoff before requeue
      outbox.channel!.nack(msg, false, true); // retryable failure → requeue
      return { ack: false, msg: null };
    }
  }
}

await startWorker();
