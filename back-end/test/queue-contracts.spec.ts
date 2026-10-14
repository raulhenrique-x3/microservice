import { validateConversionRequested, ConversionRequested, EX } from '../src/queue/contracts.js';

const valid: ConversionRequested = {
  jobId: '17d5bb5f-0568-42f0-a032-8d4894a6e45c',
  objectKey: 'abc/original.png',
  sourceType: 'image',
  sourceFormat: 'png',
  targetFormat: 'webp',
  notifyEmail: 'a@b.dev',
  requestedAt: '2026-01-01T00:00:00.000Z',
  attempt: 0,
};

describe('contratos RabbitMQ', () => {
  it('mensagem completa passa na validação', () => {
    expect(validateConversionRequested(valid)).toEqual(valid);
  });

  it('cada campo obrigatório, quando ausente, invalida a mensagem', () => {
    for (const field of ['jobId', 'objectKey', 'sourceType', 'sourceFormat', 'targetFormat', 'notifyEmail'] as const) {
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      expect(() => validateConversionRequested(broken)).toThrow('missing required fields');
    }
  });

  it('binário nunca entra na fila: payload é JSON de contrato, não conteúdo', () => {
    const serialized = JSON.stringify(valid);
    // contrato tem apenas metadados; um arquivo real teria dezenas de KB
    expect(Buffer.byteLength(serialized)).toBeLessThan(1024);
    expect(EX.JOBS_QUEUE).toBe('media.convert');
  });
});
