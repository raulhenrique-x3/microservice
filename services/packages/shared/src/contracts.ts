/**
 * Cross-service message and event contracts. This is the ONLY shared domain
 * artifact: each service owns its code and database; they coordinate strictly
 * through these types on RabbitMQ.
 */
export const EX = {
  JOBS_EXCHANGE: 'media.jobs',
  JOBS_QUEUE: 'media.convert',
  JOBS_DLX: 'media.jobs.dlx',
  JOBS_DLQ: 'media.dead',
  // topic exchange: projection queue binds '#' (all events), notifier
  // queue binds only 'completed'
  EVENTS_EXCHANGE: 'media.events',
  NOTIFIER_QUEUE: 'media.notifications',
  PROJECTION_QUEUE: 'media.projection',
  RK_CONVERT: 'convert',
  RK_COMPLETED: 'completed',
  RK_STARTED: 'started',
  RK_FAILED: 'failed',
  RK_DEAD: 'dead',
} as const;

export type MediaType = 'video' | 'audio' | 'image';

export const TARGET_FORMATS = ['mp4', 'avi', 'wav', 'mp3', 'png', 'jpeg', 'webp'] as const;
export type TargetFormat = (typeof TARGET_FORMATS)[number];

export const MIME_BY_FORMAT: Record<TargetFormat, string> = {
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Published by the API via the transactional outbox. */
export interface ConversionRequested {
  jobId: string;
  objectKey: string;
  sourceType: MediaType;
  sourceFormat: string;
  targetFormat: string;
  notifyEmail: string;
  requestedAt: string;
  attempt: number;
}

/** Published by the worker when it claims a job. */
export interface ConversionStarted {
  eventId: string;
  jobId: string;
  startedAt: string;
}

/** Published by the worker via the transactional outbox. */
export interface ConversionCompleted {
  eventId: string;
  jobId: string;
  targetFormat: string;
  resultKey: string;
  notifyEmail: string;
  completedAt: string;
}

/** Published by the worker when MAX_ATTEMPTS is exhausted. */
export interface ConversionFailed {
  eventId: string;
  jobId: string;
  errorDetail: string;
  failedAt: string;
}

const REQUIRED_REQUESTED = ['jobId', 'objectKey', 'sourceType', 'sourceFormat', 'targetFormat', 'notifyEmail'] as const;
const REQUIRED_STARTED = ['eventId', 'jobId'] as const;
const REQUIRED_COMPLETED = ['eventId', 'jobId', 'targetFormat', 'resultKey', 'notifyEmail'] as const;
const REQUIRED_FAILED = ['eventId', 'jobId', 'errorDetail'] as const;

function requireFields(o: unknown, fields: readonly string[], kind: string) {
  const m = o as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') throw new Error(`${kind} is missing required fields`);
  for (const f of fields) if (!m[f]) throw new Error(`${kind} is missing required fields`);
}

export function validateConversionRequested(o: unknown): ConversionRequested {
  requireFields(o, REQUIRED_REQUESTED, 'conversion message');
  return o as ConversionRequested;
}

export function validateConversionStarted(o: unknown): ConversionStarted {
  requireFields(o, REQUIRED_STARTED, 'start event');
  return o as ConversionStarted;
}

export function validateConversionCompleted(o: unknown): ConversionCompleted {
  requireFields(o, REQUIRED_COMPLETED, 'completion event');
  return o as ConversionCompleted;
}

export function validateConversionFailed(o: unknown): ConversionFailed {
  requireFields(o, REQUIRED_FAILED, 'failure event');
  return o as ConversionFailed;
}
