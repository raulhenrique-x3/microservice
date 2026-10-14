import { detectMediaType, isConversionAllowed, wireStatus, TARGET_FORMATS } from './media.js';

// fixture builders using real magic bytes
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
const wav = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1')]);
const avi = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('AVI ', 'latin1')]);
const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom', 'latin1')]);
const mp3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(5)]);
const mp3sync = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const txt = Buffer.from('hello world, definitely not media');

describe('detectMediaType (magic bytes, não extensão)', () => {
  it('identifica cada formato suportado', () => {
    expect(detectMediaType(png)).toEqual({ type: 'image', format: 'png' });
    expect(detectMediaType(jpeg)).toEqual({ type: 'image', format: 'jpeg' });
    expect(detectMediaType(webp)).toEqual({ type: 'image', format: 'webp' });
    expect(detectMediaType(wav)).toEqual({ type: 'audio', format: 'wav' });
    expect(detectMediaType(avi)).toEqual({ type: 'video', format: 'avi' });
    expect(detectMediaType(mp4)).toEqual({ type: 'video', format: 'mp4' });
    expect(detectMediaType(mp3)).toEqual({ type: 'audio', format: 'mp3' });
    expect(detectMediaType(mp3sync)).toEqual({ type: 'audio', format: 'mp3' });
  });

  it('rejeita conteúdo não-mídia', () => {
    expect(detectMediaType(txt)).toBeNull();
    expect(detectMediaType(Buffer.alloc(0))).toBeNull();
  });
});

describe('isConversionAllowed', () => {
  it('imagem → imagem ok', () => {
    expect(isConversionAllowed('image', 'png')).toBe(true);
    expect(isConversionAllowed('image', 'webp')).toBe(true);
  });
  it('imagem → vídeo/áudio rejeitado', () => {
    expect(isConversionAllowed('image', 'mp4')).toBe(false);
    expect(isConversionAllowed('image', 'wav')).toBe(false);
    expect(isConversionAllowed('image', 'mp3')).toBe(false);
  });
  it('vídeo/áudio → formatos ffmpeg ok, imagem rejeitada', () => {
    expect(isConversionAllowed('video', 'mp3')).toBe(true);
    expect(isConversionAllowed('video', 'avi')).toBe(true);
    expect(isConversionAllowed('audio', 'wav')).toBe(true);
    expect(isConversionAllowed('audio', 'png')).toBe(false);
    expect(isConversionAllowed('audio', 'webp')).toBe(false);
  });
  it('formato desconhecido rejeitado', () => {
    expect(isConversionAllowed('image', 'gif')).toBe(false);
  });
});

describe('wireStatus (dicionário de status p/ a API)', () => {
  it('expõe exatamente os status do projeto', () => {
    const values = Object.values(wireStatus('PENDING') as never as string);
    expect(wireStatus('PENDING')).toBe('PENDENTE');
    expect(wireStatus('PROCESSING')).toBe('PROCESSANDO');
    expect(wireStatus('DONE')).toBe('CONCLUÍDO');
    expect(wireStatus('ERRORED')).toBe('ERRO');
    expect(values.length).toBeGreaterThan(0);
    expect(TARGET_FORMATS.length).toBe(7);
  });
});
