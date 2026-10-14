export const EX = {
  JOBS_EXCHANGE: 'media.jobs',
  JOBS_QUEUE: 'media.convert',
  JOBS_DLX: 'media.jobs.dlx',
  JOBS_DLQ: 'media.dead',
  EVENTS_EXCHANGE: 'media.events',
  EVENTS_QUEUE: 'media.notifications',
  RK_CONVERT: 'convert',
  RK_COMPLETED: 'completed',
  RK_DEAD: 'dead',
} as const;

/** Published by the API via the transactional outbox. */
export interface ConversionRequested {
  jobId: string;
  objectKey: string;
  sourceType: 'video' | 'audio' | 'image';
  sourceFormat: string;
  targetFormat: string;
  notifyEmail: string;
  requestedAt: string;
  attempt: number;
}

/** Published by the worker via the transactional outbox. */
export interface ConversionCompleted {
  jobId: string;
  resultKey: string;
  notifyEmail: string;
  completedAt: string;
}

export function validateConversionRequested(o: unknown): ConversionRequested {
  const m = o as ConversionRequested;
  if (!m || typeof m !== 'object' || !m.jobId || !m.objectKey || !m.sourceType || !m.sourceFormat || !m.targetFormat || !m.notifyEmail)
    throw new Error('conversion message is missing required fields');
  return m;
}

export interface OutboxKind { kind: 'CONVERSION_REQUESTED'; payload: ConversionRequested }
