import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MinioClient, MIME_BY_FORMAT, OutboxRelay, ConversionRequested } from '@app/shared';
import { detectMediaType, isConversionAllowed, wireStatus } from '../media/media.js';
import { PrismaService } from '../services/prisma.service.js';

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private minio: MinioClient,
    private outbox: OutboxRelay,
  ) {}

  async create(file: Express.Multer.File, targetFormat: string, notifyEmail: string) {
    if (!file) throw new BadRequestException('arquivo obrigatório');
    const max = Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024; // 200 MB default
    if (file.size > max) throw new BadRequestException(`arquivo maior que ${process.env.MAX_UPLOAD_MB || 200} MB`);

    const detected = detectMediaType(file.buffer); // real type from magic bytes
    if (!detected) throw new BadRequestException('tipo de arquivo não suportado ou corrompido');
    if (!isConversionAllowed(detected.type, targetFormat))
      throw new BadRequestException(`conversão ${detected.type} → ${targetFormat} não suportada`);

    // unique, path-safe object name built from detected format only
    const objectKey = `${randomUUID()}/original.${detected.format}`;
    await this.minio.putUpload(objectKey, file.buffer, MIME_BY_FORMAT[detected.format as keyof typeof MIME_BY_FORMAT] ?? 'application/octet-stream');

    const message: ConversionRequested = {
      jobId: '',
      objectKey,
      sourceType: detected.type,
      sourceFormat: detected.format,
      targetFormat,
      notifyEmail,
      requestedAt: new Date().toISOString(),
      attempt: 0,
    };

    // job row + its outbox entry commit together: the event exists iff the job does
    const job = await this.prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          originalKey: objectKey,
          originalName: file.originalname ?? '',
          originalSize: file.size,
          sourceType: detected.type,
          sourceFormat: detected.format,
          targetFormat,
          notifyEmail,
        },
      });
      await tx.outbox.create({ data: { kind: 'CONVERSION_REQUESTED', payload: JSON.stringify({ ...message, jobId: job.id }) } });
      return job;
    });

    return { jobId: job.id };
  }

  async get(jobId: string) {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('job não encontrado');
    // live status comes from the projection (worker events); job.status is the intake fallback
    const view = await this.prisma.jobView.findUnique({ where: { jobId } });
    const status = view?.status ?? job.status;
    return {
      jobId: job.id,
      status: wireStatus(status),
      targetFormat: job.targetFormat,
      downloadUrl:
        status === 'DONE' && view?.resultKey ? ((await this.minio.presignResult(view.resultKey)) ?? undefined) : undefined,
      errorMessage: status === 'ERRORED' ? view?.errorDetail ?? 'erro no processamento' : undefined,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }
}
