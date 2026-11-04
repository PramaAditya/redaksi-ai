import { generateImage } from 'ai';
import { google } from '@ai-sdk/google';
import { uploadToS3 } from '../../s3.js';

export type ImageGeneratorStyle = 'dramatic' | 'realistic' | 'custom';
export type AspectRatio = 'auto' | '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9';
export type ImageSize = '1K' | '2K' | '4K';

export interface ImageGeneratorOptions {
  /**
   * The text prompt describing the desired image.
   */
  prompt: string;
  /**
   * Style preset:
   * - 'dramatic': Chiaroscuro, dramatic backlighting, rim lighting, deep shadows, pitch-black void edges.
   * - 'realistic': Documentary photojournalism, realistic natural lighting, sharp 35mm press photo focus.
   * - 'custom': Uses prompt directly without appending predefined style suffixes.
   * Defaults to 'dramatic'.
   */
  style?: ImageGeneratorStyle;
  /**
   * Aspect ratio of generated image. Defaults to '1:1'.
   */
  aspectRatio?: AspectRatio;
  /**
   * Output size resolution. Defaults to '1K'.
   */
  size?: ImageSize;
  /**
   * Whether to automatically upload to S3 and return `url`. Defaults to true.
   */
  uploadToS3?: boolean;
  /**
   * Maximum number of retry attempts with exponential backoff. Defaults to 3.
   */
  maxRetries?: number;
}

export interface ImageGeneratorResult {
  buffer: Buffer;
  base64?: string;
  url?: string;
  mediaType: string;
  isFallback?: boolean;
}

export const DRAMATIC_STYLE_SUFFIX =
  'masterpiece professional photography, dramatic backlighting, strong rim lighting from behind, intense edge light, front of subject in deep shadow, heavy chiaroscuro photography, extreme low key, edges fading completely into pitch black void. 4K ultra HD. Render in extreme detail with high-end remastering, sharp focus, accurate textures. Ensure it is strictly in 1:1 aspect ratio. NO TEXT whatsoever. DO NOT INCLUDE: front lighting, direct lighting, top lighting, overhead light, painting, bright background, daylight, flat lighting, overexposed, visible room edges, cutout, text, logo, signature.';

export const REALISTIC_STYLE_SUFFIX =
  'masterpiece professional photography, realistic, photorealistic, documentary photojournalism style, natural daylight and ambient lighting, sharp focus, 35mm editorial press photography, highly detailed authentic textures. 4K ultra HD. NO cartoon, NO drawing, NO illustration, NO text whatsoever, NO logo, NO watermark.';

const BLACK_FALLBACK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pure Text-to-Image generator using Gemini image models.
 */
export async function imageGenerator(options: ImageGeneratorOptions): Promise<ImageGeneratorResult> {
  const {
    prompt,
    style = 'dramatic',
    aspectRatio = '1:1',
    size = '1K',
    uploadToS3: shouldUploadToS3 = true,
    maxRetries = 3,
  } = options;

  let finalPrompt = prompt.trim();
  if (style === 'dramatic') {
    finalPrompt = `${finalPrompt}. ${DRAMATIC_STYLE_SUFFIX}`;
  } else if (style === 'realistic') {
    finalPrompt = `${finalPrompt}. ${REALISTIC_STYLE_SUFFIX}`;
  }

  const modelName = process.env.IMAGE_GENERATION_MODEL || 'gemini-3.1-flash-image-preview';
  let outputBuffer: Buffer | null = null;
  let base64Output: string | undefined;
  let mediaType = 'image/jpeg';
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[imageGenerator:${style}] Generation attempt ${attempt}/${maxRetries}...`);
      const result = await generateImage({
        model: google.image(modelName),
        prompt: finalPrompt,
        aspectRatio: aspectRatio === 'auto' ? undefined : aspectRatio,
        providerOptions: {
          google: {
            imageConfig: {
              imageSize: size,
            },
          },
        },
      });

      if (result.image?.base64) {
        base64Output = result.image.base64;
        outputBuffer = Buffer.from(base64Output, 'base64');
        mediaType = result.image.mediaType || 'image/jpeg';
        break;
      }
    } catch (error) {
      lastError = error;
      console.warn(
        `[imageGenerator:${style}] Attempt ${attempt} failed:`,
        error instanceof Error ? error.message : String(error)
      );
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await wait(delay);
      }
    }
  }

  // Fallback if all retries failed
  let isFallback = false;
  if (!outputBuffer) {
    console.warn(
      `[imageGenerator:${style}] Failed after ${maxRetries} attempts. Falling back to black transparent pixel.`
    );
    outputBuffer = BLACK_FALLBACK_PNG;
    mediaType = 'image/png';
    isFallback = true;
  }

  // S3 upload
  let url: string | undefined;
  if (shouldUploadToS3) {
    console.log(`[imageGenerator:${style}] Uploading generated image to S3...`);
    const ext = mediaType === 'image/png' ? '.png' : '.jpg';
    url = (await uploadToS3(outputBuffer, mediaType, ext)) || undefined;
  }

  return {
    buffer: outputBuffer,
    base64: base64Output,
    url,
    mediaType,
    isFallback,
  };
}

export default imageGenerator;
