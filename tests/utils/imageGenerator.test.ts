import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  imageGenerator,
  DRAMATIC_STYLE_SUFFIX,
  REALISTIC_STYLE_SUFFIX,
} from '../../src/utils/imageGenerator/index.js';
import { generateImage } from 'ai';
import * as s3 from '../../src/s3.js';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateImage: vi.fn(),
  };
});

vi.mock('../../src/s3.js', () => ({
  uploadToS3: vi.fn().mockResolvedValue('https://mock-s3.pelita.tech/generated.jpg'),
}));

describe('imageGenerator utility', () => {
  const mockBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(generateImage).mockResolvedValue({
      image: {
        base64: mockBase64,
        mediaType: 'image/jpeg',
      },
    } as any);
  });

  it('generates image with dramatic style preset by default', async () => {
    const result = await imageGenerator({
      prompt: 'Night summit stage with single speaker',
    });

    expect(generateImage).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(generateImage).mock.calls[0][0];

    expect(callArgs.prompt).toContain('Night summit stage with single speaker');
    expect(callArgs.prompt).toContain(DRAMATIC_STYLE_SUFFIX);
    expect(callArgs.aspectRatio).toBe('1:1');
    expect(s3.uploadToS3).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', '.jpg');
    expect(result.url).toBe('https://mock-s3.pelita.tech/generated.jpg');
    expect(result.buffer).toEqual(Buffer.from(mockBase64, 'base64'));
  });

  it('generates image with realistic style preset', async () => {
    const result = await imageGenerator({
      prompt: 'Diplomats shaking hands in Geneva conference room',
      style: 'realistic',
    });

    expect(generateImage).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(generateImage).mock.calls[0][0];

    expect(callArgs.prompt).toContain('Diplomats shaking hands in Geneva conference room');
    expect(callArgs.prompt).toContain(REALISTIC_STYLE_SUFFIX);
    expect(result.url).toBe('https://mock-s3.pelita.tech/generated.jpg');
  });

  it('generates image with custom style without predefined suffixes', async () => {
    const customPrompt = 'Exact vintage watercolor painting of a harbor at sunset';
    const result = await imageGenerator({
      prompt: customPrompt,
      style: 'custom',
    });

    expect(generateImage).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(generateImage).mock.calls[0][0];

    expect(callArgs.prompt).toBe(customPrompt);
    expect(result.url).toBe('https://mock-s3.pelita.tech/generated.jpg');
  });

  it('retries when generateImage fails and succeeds on retry', async () => {
    vi.mocked(generateImage)
      .mockRejectedValueOnce(new Error('Rate limit'))
      .mockResolvedValueOnce({
        image: {
          base64: mockBase64,
          mediaType: 'image/jpeg',
        },
      } as any);

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: Function) => fn()) as any;

    const result = await imageGenerator({
      prompt: 'Robotics lab testing humanoid',
      maxRetries: 3,
    });

    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(result.url).toBe('https://mock-s3.pelita.tech/generated.jpg');

    global.setTimeout = originalSetTimeout;
  });

  it('falls back to 1x1 black pixel when all retries fail', async () => {
    vi.mocked(generateImage)
      .mockRejectedValueOnce(new Error('Model quota exceeded'))
      .mockRejectedValueOnce(new Error('Model quota exceeded'))
      .mockRejectedValueOnce(new Error('Model quota exceeded'));

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: Function) => fn()) as any;

    const result = await imageGenerator({
      prompt: 'Emergency crisis room briefing',
      maxRetries: 3,
    });

    expect(generateImage).toHaveBeenCalledTimes(3);
    expect(result.mediaType).toBe('image/png');
    expect(result.isFallback).toBe(true);
    expect(s3.uploadToS3).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', '.png');

    global.setTimeout = originalSetTimeout;
  });

  it('skips S3 upload if uploadToS3 is false', async () => {
    const result = await imageGenerator({
      prompt: 'City skyline during sunrise',
      uploadToS3: false,
    });

    expect(generateImage).toHaveBeenCalledOnce();
    expect(s3.uploadToS3).not.toHaveBeenCalled();
    expect(result.url).toBeUndefined();
    expect(result.buffer).toEqual(Buffer.from(mockBase64, 'base64'));
  });
});
