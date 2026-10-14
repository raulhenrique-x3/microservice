// Read-model projection: the API consumes worker status events and applies them
// to job_views (event-carried state transfer). Each transition has a guarded
// where-clause (latest state wins, no backward jumps) + create-or-ignore on the
// unique jobId, which is what makes redelivery under at-least-once idempotent.
import { Injectable } from '@nestjs/common';
import { Channel, EX, validateConversionStarted, validateConversionCompleted, validateConversionFailed, ConversionStarted, ConversionCompleted, ConversionFailed } from '@app/shared';
import { Prisma } from '../../prisma/generated/client/index.js';
import { PrismaService } from '../services/prisma.service.js';
import { JobStatusDb } from '../media/media.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Message = NonNullable<Parameters<Parameters<Channel['consume']>[1]>[0]>;

@Injectable()
export class ProjectionConsumer {
  constructor(private prisma: PrismaService) {}

  start(ch: Channel) {
    ch.consume(EX.PROJECTION_QUEUE, (msg) => {
      if (!msg) return;
      this.handle(msg, ch).catch((e) => {
        console.error('[projection] consumed-message handling failed:', (e as Error).message);
      });
    });
  }

  private async handle(msg: Message, ch: Channel) {
    try {
      const parsed: unknown = JSON.parse(msg.content.toString());
      const rk = msg.fields.routingKey;
      if (rk === EX.RK_STARTED) {
        const e = validateConversionStarted(parsed);
        await this.applyStarted(e);
      } else if (rk === EX.RK_COMPLETED) {
        const e = validateConversionCompleted(parsed);
        await this.applyCompleted(e);
      } else if (rk === EX.RK_FAILED) {
        const e = validateConversionFailed(parsed);
        await this.applyFailed(e);
      } else {
        console.error('[projection] unknown routing key', rk);
        ch.nack(msg, false, false); // never seen here → DLQ
        return;
      }
      ch.ack(msg);
    } catch (e) {
      if ((e as Error).message.includes('missing required fields')) {
        console.error('[projection]', (e as Error).message);
        ch.nack(msg, false, false); // malformed → DLQ
        return;
      }
      console.error('[projection] error:', (e as Error).message);
      await sleep(2000);
      ch.nack(msg, false, true); // transient (db) → requeue
    }
  }

  private async applyStarted(e: ConversionStarted) {
    const r = await this.prisma.jobView.updateMany({
      where: { jobId: e.jobId, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });
    if (r.count === 0) await this.createOrIgnore({ jobId: e.jobId, status: 'PROCESSING' });
    console.log('[projection]', e.jobId, '→', 'PROCESSANDO');
  }

  private async applyCompleted(e: ConversionCompleted) {
    const r = await this.prisma.jobView.updateMany({
      where: { jobId: e.jobId, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'DONE', resultKey: e.resultKey },
    });
    if (r.count === 0) await this.createOrIgnore({ jobId: e.jobId, status: 'DONE', resultKey: e.resultKey });
    console.log('[projection]', e.jobId, '→', 'CONCLUÍDO');
  }

  private async applyFailed(e: ConversionFailed) {
    const r = await this.prisma.jobView.updateMany({
      where: { jobId: e.jobId, NOT: { status: 'DONE' } },
      data: { status: 'ERRORED', errorDetail: e.errorDetail },
    });
    if (r.count === 0) await this.createOrIgnore({ jobId: e.jobId, status: 'ERRORED', errorDetail: e.errorDetail });
    console.log('[projection]', e.jobId, '→', 'ERRO');
  }

  /* create ignoring duplicates; an orphan view (event raced the Job create)
   * is harmless — GET 404s off the Job table */
  private async createOrIgnore(data: { jobId: string; status: JobStatusDb; resultKey?: string; errorDetail?: string }) {
    try {
      await this.prisma.jobView.create({ data });
    } catch (e) {
      // already projected (duplicate delivery) — that IS success
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
  }
}
