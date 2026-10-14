import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import sharp from 'sharp';
import { MediaType } from '@app/shared';

// FFmpeg output muxers for the non-image targets (args are fixed constants —
// no user input is interpolated into the command line).
const FFMPEG_MUX: Record<string, string> = { mp4: 'mp4', avi: 'avi', wav: 'wav', mp3: 'mp3' };

export async function convertImage(buf: Buffer, target: string): Promise<Buffer> {
  return sharp(buf).toFormat(target as 'png' | 'jpeg' | 'webp', { quality: 85 }).toBuffer();
}

/**
 * shortcut: whole file buffered in memory (uploads ≤ MAX_UPLOAD_MB) and
 * conversion via on-disk temp files because piped mp4 input can't seek to a
 * trailing moov atom — switch to streamed stdin/stdout if files exceed RAM.
 */
export async function convertAV(buf: Buffer, _sourceType: MediaType, target: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'conv-'));
  const inFile = path.join(dir, 'in.bin');
  const outFile = path.join(dir, 'out.bin');
  try {
    await writeFile(inFile, buf);
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', inFile, '-y', '-f', FFMPEG_MUX[target], outFile]);
    const stderr: Buffer[] = [];
    ff.stderr.on('data', (c: Buffer) => stderr.push(c));
    const code = await new Promise<number>((resolve, reject) => {
      ff.on('error', reject);
      ff.on('close', (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new Error(`ffmpeg exit ${code}: ${Buffer.concat(stderr).toString().slice(-400)}`);
    return await readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function convert(sourceType: MediaType, _sourceFormat: string, target: string, buf: Buffer): Promise<Buffer> {
  return sourceType === 'image' ? convertImage(buf, target) : convertAV(buf, sourceType, target);
}
