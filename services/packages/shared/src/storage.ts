import { Client, ClientOptions } from 'minio';

export const BUCKETS = { upload: 'uploads', converted: 'converted' } as const;

export interface MinioClientOptions {
  endpoint: string;
  port?: number;
  accessKey: string;
  secretKey: string;
  /** host reachable from the browser/e-mail client; defaults to endpoint */
  presignHost?: string;
}

function clientFor(host: string, port: number, accessKey: string, secretKey: string) {
  // região fixa = presign nunca faz roundtrip de rede (GetBucketLocation)
  return new Client({ endPoint: host, port, useSSL: false, region: 'us-east-1', accessKey, secretKey } as ClientOptions);
}

/**
 * Thin S3 (MinIO) adapter. Each service instantiates it with its OWN scoped
 * credentials (see docker/storage policies): api writes uploads and reads
 * converted; worker reads/deletes uploads and writes converted; notifier only
 * presigns reads on converted.
 */
export class MinioClient {
  private ops: Client;
  private presigner: Client;

  constructor(o: MinioClientOptions) {
    const port = o.port ?? Number(process.env.MINIO_PORT || 9000);
    this.ops = clientFor(o.endpoint, port, o.accessKey, o.secretKey);
    this.presigner = clientFor(o.presignHost ?? o.endpoint, port, o.accessKey, o.secretKey);
  }

  private async put(bucket: string, key: string, buf: Buffer, mime: string) {
    await this.ops.putObject(bucket, key, buf, buf.length, { contentType: mime } as never);
  }

  async putUpload(key: string, buf: Buffer, mime: string) {
    await this.put(BUCKETS.upload, key, buf, mime);
  }

  async putResult(key: string, buf: Buffer, mime: string) {
    await this.put(BUCKETS.converted, key, buf, mime);
  }

  async downloadUpload(key: string): Promise<Buffer> {
    const stream = await this.ops.getObject(BUCKETS.upload, key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  async deleteUpload(key: string) {
    await this.ops.removeObject(BUCKETS.upload, key);
  }

  async ensureBucket(name: string) {
    if (!(await this.ops.bucketExists(name))) await this.ops.makeBucket(name);
  }

  /** URL for the browser/e-mail; presigned so the bucket stays private. Null when unavailable. */
  async presignResult(key: string, expiry = Number(process.env.PRESIGN_EXPIRY_SECONDS || 1800)): Promise<string | null> {
    try {
      return await this.presigner.presignedGetObject(BUCKETS.converted, key, expiry);
    } catch {
      return null;
    }
  }
}
