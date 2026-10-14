import { Injectable, NotFoundException } from '@nestjs/common';
import { Client, ClientOptions } from 'minio';

const PORT = Number(process.env.MINIO_PORT || 9000);
const HOSTS = {
  ops: process.env.MINIO_ENDPOINT || 'localhost',
  presign: process.env.MINIO_PRESIGN_HOST || 'localhost',
};
const USER = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const SECRET = process.env.MINIO_SECRET_KEY || 'minioadmin';

export const BUCKETS = { upload: 'uploads', converted: 'converted' } as const;

function clientFor(host: string) {
  // região fixa = presign nunca faz roundtrip de rede (GetBucketLocation)
  return new Client({ endPoint: host, port: PORT, useSSL: false, region: 'us-east-1', accessKey: USER, secretKey: SECRET } as ClientOptions);
}

@Injectable()
export class MinioService {
  private ops = clientFor(HOSTS.ops);
  private presigner = clientFor(HOSTS.presign);

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

  /** URL for the browser/e-mail; presigned so bucket stays private. */
  async presignResult(key: string, expiry = Number(process.env.PRESIGN_EXPIRY_SECONDS || 1800)): Promise<string> {
    try {
      return await this.presigner.presignedGetObject(BUCKETS.converted, key, expiry);
    } catch {
      throw new NotFoundException('arquivo convertido indisponível');
    }
  }
}
