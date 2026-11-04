import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { PipelineContext, ResearchResult, googleAI, withRetry, mapWithConcurrency, SLIDE_CONCURRENCY } from '../../../../utils.js';
import { censorText } from '../../../../sanitize.js';
import { uploadToS3 } from '../../../../s3.js';
import { generateMedia } from '../../../../media.js';
import { insertQueueItem } from '../../../../db/queue.js';
import { curateImages } from '../../../image-curator/index.js';
import { marked } from 'marked';
import { imageEditor, imageGenerator } from '../../../../utils/imageEditor/index.js';
import { sanitizeSourceUrl, getCleanDomain } from '../../../../utils/urlSanitizer.js';
import { generateQrCodeDataUrl } from '../../../../utils/qrGenerator.js';
// Helper for Roman numerals
const toRoman = (num: number) => {
  const roman: Record<string, number> = {
    M: 1000, CM: 900, D: 500, CD: 400, C: 100, XC: 90, L: 50, XL: 40, X: 10, IX: 9, V: 5, IV: 4, I: 1
  };
  let str = '';
  for (let i of Object.keys(roman)) {
    let q = Math.floor(num / roman[i]);
    num -= q * roman[i];
    str += i.repeat(q);
  }
  return str;
};

export const carouselMultiImagesTemplateConfig = {
  id: 'image:poros.perjuangan:carousel_multi_images',
  name: 'Carousel Multi Images',
  description: 'A 4-slide breaking news carousel with a cover image and 3 content slides each with its own curated image.',
  albumStrategy: 'first_only' as const,
  uiSchema: [
    { name: 'title', type: 'text', label: 'Title (supports **bold**)', aiContext: 'This is the title of a sensational news post. It should be scroll-stopping, casual, highly sensational, and provocative (but factual) breaking news style targeted at Gen Z Indonesians.' },
    { name: 'source_name', type: 'string', label: 'Source Media Name' },
    { name: 'source_url', type: 'string', label: 'Source Article URL' },
    { name: 'coverImageUrl', type: 'image', label: 'Cover Image' },
    { name: 'slides', type: 'array', label: 'Slides', itemType: 'object', itemSchema: [
      { name: 'text', type: 'text', label: 'Slide Text (supports **bold**)', aiContext: 'This is one slide out of a multi-slide news carousel. It should be written in clear, accessible, and easily understood Indonesian (Bahasa Indonesia yang membumi). Keep it PUNCHY, CONCISE, and FAST-PACED (singkat, padat, jelas) for a Gen-Z audience with a short attention span.' },
      { name: 'slide_image', type: 'image', label: 'Slide Background Image' }
    ]}
  ] as any[]
};

export async function generateCarouselMultiImagesMedia(templateData: any, settings: any): Promise<{ type: 'image', url: string }[]> {
  const pages: any[] = [];
  
  pages.push({
    file: 'cover',
    context: {
      logo: settings.logoImageUrl || 'https://storage.pelita.tech/logo_poros_perjuangan_white.png',
      cover_image: templateData.coverImageUrl,
      title: marked.parseInline(templateData.title || '')
    }
  });

  if (templateData.slides) {
    templateData.slides.forEach((slide: any, i: number) => {
      pages.push({
        file: 'slide',
        context: {
          cover_image: templateData.coverImageUrl,
          slide_image: slide.slide_image,
          text: marked.parse(slide.text || ''),
          roman_number: toRoman(i + 1)
        }
      });
    });
  }

  if (templateData.source_url) {
    try {
      const cleanUrl = sanitizeSourceUrl(templateData.source_url);
      if (cleanUrl) {
        const qrDataUrl = await generateQrCodeDataUrl(cleanUrl);
        pages.push({
          file: 'source_qr',
          context: {
            source_name: templateData.source_name || 'Sumber Resmi',
            source_domain: getCleanDomain(cleanUrl),
            qr_code_image: qrDataUrl,
          }
        });
      }
    } catch (qrErr) {
      console.warn('Failed to generate QR code slide:', qrErr);
    }
  }
  if (templateData.inputImages) {
    templateData.inputImages.forEach((url: string) => {
      pages.push({
        file: 'image',
        context: {
          logo: settings.logoImageUrl || 'https://storage.pelita.tech/logo_poros_perjuangan_white.png',
          image_url: url
        }
      });
    });
  }

  const renderPayload = {
    viewport: { width: 1080, height: 1350 },
    pages
  };

  const renderedUrls = await generateMedia('/render/image/poros.perjuangan/carousel_multi_images', renderPayload);

  if (!renderedUrls || renderedUrls.length === 0) {
    throw new Error('Failed to render images from external API.');
  }

  return renderedUrls.map((url: string) => ({
    type: 'image' as const,
    url
  }));
}

export async function runCarouselMultiImagesPipeline(
  context: PipelineContext,
  research: ResearchResult,
  agentInsights?: Record<string, string>
) {
  const { chatId, messageId, telegram, statusMsg, userInput, settings, currentDateStr, baseSystemPrompt } = context;
  const { researchText, scrapedImageUrl, processedMedia } = research;
  const insights = agentInsights || context.agentInsights || (researchText ? { research: researchText } : {});
  const defaultGuidelines = process.env.EDITORIAL_GUIDELINES || `Your reporting should maintain a professional and highly informative journalistic tone. Focus on delivering factual news while highlighting perspectives from the Global South, particularly Palestine, Lebanon, Iran, Iraq, and Yemen. When covering conflicts or international relations, critically examine the roles, policies, and actions of the US, Israel, and their allies.\n\nCrucially, avoid emotive language, sensationalism, or blatant propaganda. Let the facts, context, and a comprehensive delivery of the 5W1H (Who, What, When, Where, Why, How) drive the narrative. Your goal is to inform the audience thoroughly and objectively within the constraints of a short format.`;
  const editorialGuidelines = settings.editorialGuidelines || defaultGuidelines;
  const bannedWords = settings.bannedWords || [];
  
  const bannedWordsPrompt = bannedWords.length > 0 
    ? `\n\nCRITICAL MODERATION RULE:\nYou are allowed to discuss sensitive topics, but you MUST replace specific words with their safe alternatives for spelling. Whenever you would normally write one of the following words, you MUST use its exact replacement instead:\n${bannedWords.map((w: any) => `- Replace "${w.word}" with "${w.replacement}"`).join('\n')}`
    : '';

  const imageMediaItems = processedMedia ? processedMedia.filter(m => m.type === 'image' && m.buffer) : [];
  
  const slideCount = 3;

  const dynamicSystemPromptAdditions = `
Your task is to parse the gathered facts into final components for an Instagram news carousel.
- title: Scroll-stopping, casual, highly sensational, and provocative (but factual) breaking news style. Target audience is Gen Z Indonesians. Use natural, modern, and impactful Indonesian phrasing. AVOID sounding repetitive, robotic, or overusing cliché slang like "Kena Mental" or "Skakmat". Make it sound like an authentic viral news alert on social media. Highlight the key factual phrase with HTML tags (<strong>text</strong>). Do NOT use markdown. IT MUST BE PROPER TITLE CASING (Capitalize the first letter of each major word, including inside the tags).
- slides: An array of exactly ${slideCount} objects, representing ${slideCount} slides explaining the news. Write in clear, accessible, and easily understood Indonesian (Bahasa Indonesia yang membumi). Keep it PUNCHY, CONCISE, and FAST-PACED (singkat, padat, jelas) for a Gen-Z audience with a short attention span. AVOID complex political or academic jargon. Each slide MUST be exactly 1 short paragraph containing at most 2 sentences. Get straight to the point without unnecessary fluff. Answer the 5W1H comprehensively across the ${slideCount} slides. Do NOT repeat information already stated in the title.
  For each slide, you must also provide an \`image_search_query\` which is a concrete, real-world noun search query in English to find a relevant background image for that specific slide's content.
- source_name: The original news source (e.g., Antara News, Kompas, Al Jazeera).
- source_url: The direct HTTP/HTTPS URL of the primary article referenced.
- image_prompt: A prompt for an AI image generator to create an accompanying cover background image. MUST specify: "masterpiece professional photography, dramatic backlighting, heavy chiaroscuro, extreme low key".
`;

  const dynamicSchema = z.object({
    title: z.string(),
    slides: z.array(z.object({
      text: z.string().describe('Max 2 sentences.'),
      image_search_query: z.string().describe('Search query in English for a relevant background image.')
    })).length(slideCount),
    source_name: z.string(),
    source_url: z.string().optional(),
    image_prompt: z.string(),
  });

  // Phase 2: Content Generation
  console.log(`[Phase 2] Generating content using template schema`);
  const writerSystemPrompt = baseSystemPrompt + `\n\nEDITORIAL GUIDELINES & FRAMING:\n${editorialGuidelines}\n\n${dynamicSystemPromptAdditions}` + bannedWordsPrompt;
  
  const { object: contentParams } = await generateObject({
    model: googleAI(process.env.CONTENT_WRITER_MODEL || 'gemini-3.1-pro-preview'),
    system: writerSystemPrompt,
    schema: dynamicSchema,
    prompt: `Original User Input/Caption:\n${userInput}\n\nGathered Facts:\n\n${researchText}${research.candidateSources && research.candidateSources.length > 0 ? '\n\nCandidate Source URLs:\n' + research.candidateSources.map(c => `- ${c.title || c.domain || ''}: ${c.url}`).join('\n') : ''}`,
  });
  
  let finalCaption = '';
  if (contentParams.slides && contentParams.source_name) {
    finalCaption = `${contentParams.slides.map(s => s.text).join('\n\n')}\n\n${currentDateStr}. Sumber: ${contentParams.source_name}`;
  } else {
    finalCaption = `${currentDateStr}.`; // Generic fallback
  }
  
  finalCaption = censorText(finalCaption, bannedWords);

  await withRetry(() => telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, '🖼️ Mempersiapkan gambar...'));

  // Phase 3: Image Sourcing & Cover Generation
  const heroMode: '4K-Enhance' | 'Dark-Dramatize' = context.heroStyle === '4K-Enhance' ? '4K-Enhance' : 'Dark-Dramatize';
  console.log(`[Phase 3] Generating cover image with imageEditor (Mode: ${heroMode})...`);
  const coverResult = await imageEditor({
    mode: heroMode,
    image: imageMediaItems.length > 0 ? imageMediaItems[0].buffer : null,
    scrapedImageUrl,
    searchQuery: contentParams.title,
    prompt: heroMode === '4K-Enhance' ? undefined : contentParams.image_prompt,
    uploadToS3: true,
  });

  const coverImageUrl = coverResult.url;
  if (!coverImageUrl) {
    throw new Error('Gagal mendapatkan URL gambar.');
  }

  // Phase 3.5: Curate Images for Slides (Parallel with Bounded Concurrency)
  await withRetry(() => telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, '🔍 Mencari gambar untuk setiap slide...'));
  
  const curatedSlides = await mapWithConcurrency(
    contentParams.slides,
    SLIDE_CONCURRENCY,
    async (slide: any, i: number) => {
      console.log(`[Phase 3.5] Curating image for slide ${i + 1}: ${slide.image_search_query}`);
      let slide_image = '';
      try {
        const curated = await curateImages({
          query: slide.image_search_query,
          context: slide.text,
          targetCount: 1
        });
        
        if (curated && curated.length > 0 && curated[0].originalUrl) {
          console.log(`[Phase 3.5] Downloading curated image for slide ${i + 1}: ${curated[0].originalUrl}`);
          const res = await fetch(curated[0].originalUrl, { signal: AbortSignal.timeout(10000) });
          if (res.ok) {
            let mimeType = res.headers.get('content-type') || 'image/jpeg';
            if (!mimeType.startsWith('image/')) {
              mimeType = 'image/jpeg';
            }
            const ext = mimeType === 'image/png' ? '.png' : '.jpg';
            const arrayBuffer = await res.arrayBuffer();
            slide_image = await uploadToS3(Buffer.from(arrayBuffer), mimeType, ext) || '';
          }
        }
      } catch (e: any) {
        console.warn(`[Phase 3.5] Failed to curate or upload image for slide ${i + 1}:`, e.message);
      }
      
      if (!slide_image) {
        console.log(`[Phase 3.5] No image found for slide ${i + 1}. Generating via imageGenerator (realistic)...`);
        try {
          const generated = await imageGenerator({
            prompt: slide.image_search_query,
            style: 'realistic',
            aspectRatio: '1:1',
            uploadToS3: true,
          });
          slide_image = (!generated.isFallback && generated.url) ? generated.url : coverImageUrl;
        } catch (err: any) {
          console.warn(`[Phase 3.5] Failed to generate slide image:`, err.message);
        }
      }

      return {
        text: slide.text,
        slide_image
      };
    }
  );
  await withRetry(() => telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, '🎨 Merender desain post...'));

  // Phase 4: Image Rendering
  console.log(`[Phase 4] Rendering media via API for template ${carouselMultiImagesTemplateConfig.id}`);
  
  let cleanTitle = contentParams.title || '';
  if (cleanTitle) {
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}]/gu;
    cleanTitle = censorText(cleanTitle.replace(emojiRegex, ''), bannedWords);
  }

  let templateData: any = { title: cleanTitle, coverImageUrl };

  if (curatedSlides.length > 0) {
    await withRetry(() => telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, '✨ Menambahkan highlight teks...'));
    console.log(`[Phase 4] Enhancing slides with markdown bolding via gemini-3.1-flash-lite...`);
    
    const highlightText = async (text: string) => {
      try {
        const { text: boldedText } = await generateText({
          model: googleAI('gemini-3.1-flash-lite'),
          system: `You are an editor for an news based social media. Your task is to add bold markdown (using **text**) to the most important or shocking words, phrases, or clauses in the provided text. 
This helps readers scan the text and prevents it from being monotonous.
RULES:
1. Do not change any original words, only add ** around the important parts.
2. Output ONLY the modified text, nothing else.
3. Don't bold everything, just the key highlights (maximum 20-30% of the text).`,
          prompt: text
        });
        return boldedText.trim() || text;
      } catch (err) {
        console.warn('Failed to add bolding to text, falling back to original text:', err);
        return text;
      }
    };

    const enhancedSlides = await Promise.all(curatedSlides.map(async (slide: any) => {
      const boldedText = await highlightText(slide.text);
      return {
        text: censorText(boldedText, bannedWords),
        slide_image: slide.slide_image
      };
    }));
    templateData.slides = enhancedSlides;
  } else {
    templateData.slides = [];
  }

  await withRetry(() => telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, '🎨 Merender desain post...'));

  const pages: any[] = [];
  
  pages.push({
    file: 'cover',
    context: {
      logo: settings.logoImageUrl || 'https://storage.pelita.tech/logo_poros_perjuangan_white.png',
      cover_image: coverImageUrl,
      title: marked.parseInline(templateData.title || '')
    }
  });

  if (templateData.slides) {
    templateData.slides.forEach((slide: any, i: number) => {
      pages.push({
        file: 'slide',
        context: {
          cover_image: coverImageUrl,
          slide_image: slide.slide_image,
          text: marked.parse(slide.text || ''),
          roman_number: toRoman(i + 1)
        }
      });
    });
  }

  const chosenSourceUrl = sanitizeSourceUrl(contentParams.source_url || research.primarySourceUrl || '');
  templateData.source_url = chosenSourceUrl || undefined;
  templateData.source_name = contentParams.source_name;

  if (templateData.source_url) {
    try {
      const qrDataUrl = await generateQrCodeDataUrl(templateData.source_url);
      pages.push({
        file: 'source_qr',
        context: {
          source_name: templateData.source_name || 'Sumber Resmi',
          source_domain: getCleanDomain(templateData.source_url),
          qr_code_image: qrDataUrl,
        }
      });
    } catch (qrErr) {
      console.warn('Failed to generate QR code slide:', qrErr);
    }
  }
  const renderPayload = {
    viewport: { width: 1080, height: 1350 },
    pages
  };

  const renderedUrls = await generateMedia('/render/image/poros.perjuangan/carousel_multi_images', renderPayload);

  if (!renderedUrls || renderedUrls.length === 0) {
    throw new Error('Gagal merender carousel dari API.');
  }

  await withRetry(() => telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, '🚀 Mempublikasikan ke Queue...'));

  // Phase 5: Publishing via Queue
  console.log(`[Phase 5] Saving to Queue and preparing Buffer URLs`);
  
  let allPublishUrls: { type: 'image', url: string }[] = renderedUrls.map(url => ({
    type: 'image',
    url
  }));

  console.log(`[Phase 5] Saving to Queue with ${allPublishUrls.length} media items`);
  
  templateData.coverImageUrl = coverImageUrl; 
  templateData.inputImages = [];
  
  const [inserted] = await insertQueueItem({
    connectionId: settings.id,
    templateId: carouselMultiImagesTemplateConfig.id,
    templateData: templateData,
    text: finalCaption,
    media: allPublishUrls,
    status: 'pending',
    chatId: chatId,
    messageId: messageId,
    researchResult: researchText,
    agentInsights: insights,
    rawInput: userInput
  });
  const postButton = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✏️ Edit Queued Post', url: `${process.env.APP_URL}/post/${inserted.id}` }]
      ]
    }
  };

  console.log(`[Phase 5] Sending final output photo/message to user with post button`);
  let previewBuffer: Buffer | undefined;
  try {
    const response = await fetch(renderedUrls[0]);
    if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
    const arrayBuffer = await response.arrayBuffer();
    previewBuffer = Buffer.from(arrayBuffer);
  } catch (e) {
    console.warn('Failed to fetch preview cover image:', e);
  }

  if (previewBuffer) {
    if (finalCaption.length > 1024) {
      await withRetry(() => telegram.sendPhoto(chatId, { source: previewBuffer }, { reply_to_message_id: messageId }));
      await withRetry(() => telegram.sendMessage(chatId, finalCaption, { reply_to_message_id: messageId, ...postButton }));
    } else {
      await withRetry(() => telegram.sendPhoto(chatId, 
         { source: previewBuffer },
        { caption: finalCaption, reply_to_message_id: messageId, ...postButton }
      ));
    }
  } else {
    await withRetry(() => telegram.sendMessage(chatId, finalCaption + `\n\nCover URL: ${renderedUrls[0]}`, { reply_to_message_id: messageId, ...postButton }));
  }

  await withRetry(() => telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id)).catch(() => {});
  console.log(`[Done] Pipeline finished successfully.`);
}