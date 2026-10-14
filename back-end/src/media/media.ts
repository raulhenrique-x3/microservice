// Wire-visible status values (project spec) and their DB enum counterparts.
export const WIRE_STATUS = {
  PENDENTE: 'PENDENTE',
  PROCESSANDO: 'PROCESSANDO',
  CONCLUÍDO: 'CONCLUÍDO',
  ERRO: 'ERRO',
} as const;

export type JobStatusDb = 'PENDING' | 'PROCESSING' | 'DONE' | 'ERRORED';

export function wireStatus(status: JobStatusDb): string {
  return { PENDING: 'PENDENTE', PROCESSING: 'PROCESSANDO', DONE: 'CONCLUÍDO', ERRORED: 'ERRO' }[status];
}

export type MediaType = 'video' | 'audio' | 'image';

export const TARGET_FORMATS = ['mp4', 'avi', 'wav', 'mp3', 'png', 'jpeg', 'webp'] as const;
export type TargetFormat = (typeof TARGET_FORMATS)[number];

const FORMAT_TYPE: Record<TargetFormat, MediaType> = {
  mp4: 'video',
  avi: 'video',
  wav: 'audio',
  mp3: 'audio',
  png: 'image',
  jpeg: 'image',
  webp: 'image',
};

//#region magic-byte detection (do not trust file extensions)
function is(at: number, magic: Buffer, buf: Buffer): boolean {
  if (buf.length < at + magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[at + i] !== magic[i]) return false;
  return true;
}

export function detectMediaType(buf: Buffer): { type: MediaType; format: string } | null {
  if (is(0, Buffer.from([0x89, 0x50, 0x4e, 0x47]), buf)) return { type: 'image', format: 'png' };
  if (is(0, Buffer.from([0xff, 0xd8, 0xff]), buf)) return { type: 'image', format: 'jpeg' };
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return { type: 'video', format: 'mp4' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF') {
    const f = buf.toString('latin1', 8, 12);
    if (f === 'WEBP') return { type: 'image', format: 'webp' };
    if (f === 'WAVE') return { type: 'audio', format: 'wav' };
    if (f === 'AVI ' || f === 'AVIX') return { type: 'video', format: 'avi' };
  }
  if (is(0, Buffer.from('ID3', 'latin1'), buf)) return { type: 'audio', format: 'mp3' };
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { type: 'audio', format: 'mp3' };
  return null;
}
//#endregion

// image sources reach image targets only; video/audio sources reach
// video/audio targets (including audio extraction from video)
export function isConversionAllowed(sourceType: MediaType, targetFormat: string): boolean {
  const t = FORMAT_TYPE[targetFormat as TargetFormat];
  if (!t) return false;
  if (sourceType === 'image') return t === 'image';
  return t !== 'image';
}

export const MIME_BY_FORMAT: Record<TargetFormat, string> = {
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
