import { loadDotEnv } from '@app/shared';
loadDotEnv();
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { PrismaService } from './services/prisma.service.js';
import {
  Channel,
  EX,
  MinioClient,
  connectRabbit,
  validateConversionCompleted,
} from '@app/shared';
import type { ConversionCompleted } from '@app/shared';
import { Prisma } from '../prisma/generated/client/index.js';

let ch: Channel | undefined;

@Module({
  providers: [
    PrismaService,
    {
      provide: MinioClient,
      useFactory: () =>
        new MinioClient({
          endpoint: process.env.MINIO_ENDPOINT || 'localhost',
          port: Number(process.env.MINIO_PORT || 9000),
          accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
          secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
          presignHost: process.env.MINIO_PRESIGN_HOST,
        }),
    },
  ],
})
export class NotifierModule {}

export async function startNotifier() {
  const app = await NestFactory.createApplicationContext(NotifierModule, { logger: ['log', 'warn', 'error'] });
  const prisma = app.get(PrismaService);
  const minio = app.get(MinioClient);
  ch = await connectRabbit();

  const mail = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT || 1025),
    secure: false,
    tls: { rejectUnauthorized: false },
  });

  ch.consume(EX.NOTIFIER_QUEUE, async (msg) => {
    if (!msg) return;
    const log = (...a: unknown[]) => console.log('[notifier]', ...a);
    try {
      let e: ConversionCompleted;
      try {
        e = validateConversionCompleted(JSON.parse(msg.content.toString()));
      } catch (err) {
        console.error('[notifier] error: invalid completion event → DLQ:', (err as Error).message);
        ch!.nack(msg, false, false);
        return;
      }

      // duplicate-prevention: create-if-absent claim — the unique jobId (P2002
      // on a re-delivered event) wins exactly once, like the old conditional
      // updateMany on notifiedAt
      try {
        await prisma.notifiedJob.create({ data: { jobId: e.jobId } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          log('job', e.jobId, 'already notified → ack (idempotent)');
          ch!.ack(msg);
          return;
        }
        throw err;
      }

      // presign is offline (fixed region, no network roundtrip): null means an
      // S3 misconfig, not a transient failure → treat as an error
      const link = await minio.presignResult(e.resultKey!);
      if (!link) throw new Error('arquivo convertido indisponível');
      const subject = `Sua conversão ${e.targetFormat.toUpperCase()} foi concluída`;
      const text = `Seu arquivo foi processado.\nBaixe em: ${link}\nO link expira em 30 minutos.`;
      try {
        await mail.sendMail({
          from: 'conversor@local',
          to: e.notifyEmail,
          subject,
          text,
          html: `<p>Seu arquivo foi processado.</p><p><a href="${link}">Baixar arquivo convertido</a></p><p><em>O link expira em 30 minutos.</em></p>`,
        });
        log('e-mail enviado para', e.notifyEmail, 'job', e.jobId);
        ch!.ack(msg);
      } catch (err) {
        // reset the claim so a redelivery can retry the send
        await prisma.notifiedJob.deleteMany({ where: { jobId: e.jobId } });
        // only ONE requeue: a redelivery means the send already failed once;
        // most SMTP failures here are permanent (bad recipient) → dead-letter
        if (msg.fields.redelivered) { console.error('[notifier] permanent failure → DLQ:', (err as Error).message); ch!.nack(msg, false, false); return; }
        throw err;
      }
    } catch (err) {
      console.error('[notifier] error:', (err as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
      try { ch!.nack(msg, false, true); } catch {} // retryable → requeue
    }
  });
  console.log('[notifier] consuming', EX.NOTIFIER_QUEUE);
}

await startNotifier();
