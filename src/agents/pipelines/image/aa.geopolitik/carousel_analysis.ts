import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { PipelineContext, ResearchResult, googleAI, withRetry } from '../../../../utils.js';
import { censorText } from '../../../../sanitize.js';
import { uploadToS3 } from '../../../../s3.js';
import { generateMedia } from '../../../../media.js';
import { insertQueueItem } from '../../../../db/queue.js';
import { marked } from 'marked';
import { imageEditor, imageGenerator } from '../../../../utils/imageEditor/index.js';
import { buildPromptContextFromInsights } from '../../../editorial/registry.js';

export function isStructuredSlideScript(input: string): boolean {
  if (!input) return false;
  const hasMultipleSlides = /\bslide\s*1\b/i.test(input) && /\bslide\s*2\b/i.test(input);
  const hasHeadlineTeksPattern = (input.match(/\b(headline|judul)\s*:/gi)?.length || 0) >= 2;
  return hasMultipleSlides || hasHeadlineTeksPattern;
}

export const carouselAnalysisTemplateConfig = {
  id: 'image:aa.geopolitik:carousel_analysis',
  name: 'Carousel Analysis (AA Geopolitik)',
  description: 'An in-depth geopolitical analysis carousel featuring impactful Bebas Neue headlines, Alumni Sans analytical body copy, and amber contrast highlights.',
  albumStrategy: 'all_as_slides' as const,
  reduceTextOnAlbum: true,
  slidesComposition: { news: 0, opinion: 8 },
  requiredEditorialAgents: ['research', 'opinion'],
  regenerateContent: async (templateData: any, settings: any, insights: Record<string, string>, context: PipelineContext) => {
    const { title, subtitle, slides, source_name, source_url, finalCaption } = await generateCarouselAnalysisContent(context, insights);
    return {
      text: finalCaption,
      templateData: {
        ...templateData,
        title,
        subtitle,
        slides,
        source_name,
        source_url: source_url || templateData.source_url,
      }
    };
  },
  uiSchema: [
    { 
      name: 'title', 
      type: 'text', 
      label: 'Main Headline (Bebas Neue, supports **bold** / <strong> for amber)', 
      aiContext: 'Scroll-stopping headline for geopolitical analysis in Bahasa Indonesia. Bold important keywords with **text** or <strong>text</strong> to turn them amber.' 
    },
    { 
      name: 'subtitle', 
      type: 'text', 
      label: 'Cover Subtitle (Alumni Sans)', 
      aiContext: 'A punchy, intriguing subtitle framing the problem or misconception, e.g. "Banyak yang Masih Salah Paham".' 
    },
    { name: 'source_name', type: 'string', label: 'Source Media Name' },
    { name: 'source_url', type: 'string', label: 'Source Article URL' },
    { name: 'image_prompt', type: 'string', label: 'Cover AI Image Prompt (English)' },
    { name: 'coverImageUrl', type: 'image', label: 'Cover Image' },
    {
      name: 'slides',
      type: 'array',
      label: 'Analysis Slides (Dynamic Story Arc)',
      itemType: 'polymorphic',
      slideTypes: [
        {
          type: 'opinion',
          label: 'Analisis Opini',
          icon: 'Lightbulb',
          requiredInsights: ['research', 'opinion'],
          promptInstruction: 'Sintesis fakta geopolitik dengan sudut pandang analitis tajam. Berikan judul pertanyaan/tesis di title dan analisis di text.',
          fields: [
            {
              name: 'title',
              type: 'text',
              label: 'Slide Question / Heading (Bebas Neue, **bold** = amber)',
              aiContext: 'A bold question or key thesis heading for this analysis slide. Bold the highlight word.'
            },
            {
              name: 'text',
              type: 'text',
              label: 'Analytical Paragraph (Alumni Sans, supports **bold**)',
              aiContext: 'Detailed geopolitical insight in accessible Bahasa Indonesia. Use **bold** on pivotal keywords and power verbs.'
            },
            {
              name: 'image_prompt',
              type: 'string',
              label: 'Slide AI Image Prompt (English)'
            },
            {
              name: 'slide_image',
              type: 'image',
              label: 'Slide Background Image (Optional)'
            }
          ]
        },
        {
          type: 'news',
          label: 'Fakta Geopolitik',
          icon: 'Newspaper',
          requiredInsights: ['research'],
          promptInstruction: 'Fokus murni pada fakta 5W1H peristiwa internasional/geopolitik yang terjadi.',
          fields: [
            {
              name: 'title',
              type: 'text',
              label: 'Slide Heading (Bebas Neue, **bold** = amber)'
            },
            {
              name: 'text',
              type: 'text',
              label: 'Factual Paragraph (Alumni Sans, supports **bold**)'
            },
            {
              name: 'image_prompt',
              type: 'string',
              label: 'Slide AI Image Prompt (English)'
            },
            {
              name: 'slide_image',
              type: 'image',
              label: 'Slide Background Image (Optional)'
            }
          ]
        },
        {
          type: 'text',
          label: 'Text Slide',
          icon: 'FileText',
          requiredInsights: ['research'],
          fields: [
            {
              name: 'title',
              type: 'text',
              label: 'Slide Heading (Bebas Neue)'
            },
            {
              name: 'text',
              type: 'text',
              label: 'Slide Text (Alumni Sans)'
            }
          ]
        },
        {
          type: 'image',
          label: 'Full Image / Map',
          icon: 'Image',
          requiredInsights: [],
          fields: [
            {
              name: 'imageUrl',
              type: 'image',
              label: 'Full Slide Image'
            }
          ]
        }
      ]
    }
  ] as any[]
};

export async function generateCarouselAnalysisMedia(templateData: any, settings: any): Promise<{ type: 'image' | 'video', url: string }[]> {
  const pages: any[] = [];
  
  pages.push({
    file: 'cover',
    context: {
      logo: settings?.logoImageUrl || '',
      cover_image: templateData.coverImageUrl,
      title: marked.parseInline(templateData.title || ''),
      subtitle: templateData.subtitle || '',
      cta_text: templateData.cta_text || 'Read More'
    }
  });

  if (templateData.slides && Array.isArray(templateData.slides)) {
    templateData.slides.forEach((slide: any, index: number) => {
      if (slide && typeof slide === 'object' && (slide.type === 'image' || (!slide.type && slide.imageUrl))) {
        pages.push({
          file: 'image',
          context: {
            logo: settings?.logoImageUrl || '',
            image_url: slide.imageUrl
          }
        });
      } else {
        const rawTitle = slide?.title ? marked.parseInline(slide.title) : '';
        const rawText = typeof slide === 'string' ? slide : (slide?.text || '');
        pages.push({
          file: 'slide',
          context: {
            logo: settings?.logoImageUrl || '',
            cover_image: templateData.coverImageUrl,
            slide_image: slide?.slide_image || templateData.coverImageUrl,
            title: rawTitle,
            text: marked.parse(rawText)
          }
        });
      }
    });
  }

  if (templateData.inputImages) {
    templateData.inputImages.forEach((url: string) => {
      pages.push({
        file: 'image',
        context: {
          logo: settings?.logoImageUrl || '',
          image_url: url
        }
      });
    });
  }


  const renderPayload = {
    viewport: { width: 1080, height: 1350 },
    pages
  };

  const renderedUrls = await generateMedia('/render/image/aa.geopolitik/carousel_analysis', renderPayload);

  if (!renderedUrls || renderedUrls.length === 0) {
    throw new Error('Failed to render carousel from external API.');
  }

  return renderedUrls.map((url: string) => ({
    type: 'image' as const,
    url
  }));
}

export async function runCarouselAnalysisPipeline(
  context: PipelineContext,
  research: ResearchResult,
  agentInsights?: Record<string, string>
) {
  const { userInput, telegram, statusMsg, chatId, messageId, settings, candidateSources } = context;
  const bannedWords = settings?.bannedWords || [];
  const insights = agentInsights || { research: research.text };
  const notifyStatus = async (text: string) => {
    if (telegram && statusMsg?.chat?.id && statusMsg?.message_id) {
      await withRetry(() => telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, text)).catch(() => {});
    }
  };

  await notifyStatus('✍️ Menulis analisis geopolitik...');

  // Phase 1: Content Synthesis
  console.log(`[Phase 1] Synthesizing Geopolitical Analysis via Gemini...`);
  const contentParams = await generateCarouselAnalysisContent(context, insights, candidateSources, research.primarySourceUrl);

  // Phase 2: Cover Visual Curation / Generation
  await notifyStatus('🎨 Menyiapkan visual cover...');

  const isAlbum = context.mediaItems && context.mediaItems.length > 0;
  const imageMediaItems = isAlbum ? context.mediaItems.filter(item => item.type === 'image') : [];

  if (imageMediaItems.length > 0 && imageMediaItems[0].buffer) {
    console.log(`[Phase 2] Using user uploaded image for cover...`);
    const uploadedUrl = await uploadToS3(
      imageMediaItems[0].buffer, 
      imageMediaItems[0].mimeType || 'image/jpeg', 
      imageMediaItems[0].mimeType === 'image/png' ? '.png' : '.jpg'
    );
    if (uploadedUrl) coverImageUrl = uploadedUrl;
  }

  if (!coverImageUrl) {
    const heroMode: '4K-Enhance' | 'Dark-Dramatize' = context.heroStyle === '4K-Enhance' ? '4K-Enhance' : 'Dark-Dramatize';
    console.log(`[Phase 2] Generating cover visual with imageEditor (Mode: ${heroMode}, Prompt: "${contentParams.image_prompt}")...`);
    try {
      const coverResult = await imageEditor({
        mode: heroMode,
        image: imageMediaItems.length > 0 ? imageMediaItems[0].buffer : null,
        scrapedImageUrl: context.scrapedImageUrl,
        searchQuery: contentParams.title,
        prompt: heroMode === '4K-Enhance' ? undefined : contentParams.image_prompt,
        uploadToS3: true,
      });
      if (coverResult?.url) coverImageUrl = coverResult.url;
    } catch (imgErr) {
      console.warn('Failed to generate cover via imageEditor, falling back to placeholder:', imgErr);
      coverImageUrl = 'https://images.unsplash.com/photo-1541872703-74c5e44368f9?q=80&w=1080&auto=format&fit=crop';
    }
  }

  let extraImageUrls: string[] = [];
  if (isAlbum && carouselAnalysisTemplateConfig.albumStrategy === 'all_as_slides') {
    for (const item of imageMediaItems.slice(1)) {
      if (item.buffer) {
        const url = await uploadToS3(item.buffer, item.mimeType || 'image/jpeg', item.mimeType === 'image/png' ? '.png' : '.jpg');
        if (url) extraImageUrls.push(url);
      }
    }
  }
  // Phase 2.5: Auto Generate Contextual Images for Each Slide
  await notifyStatus('🖼️ Menghasilkan visual latar untuk setiap slide...');
  console.log(`[Phase 2.5] Generating atmospheric visual backgrounds for ${contentParams.slides.length} slides...`);
  
  const slideImages: string[] = [];
  for (let i = 0; i < contentParams.slides.length; i++) {
    const slide = contentParams.slides[i];
    if (extraImageUrls[i]) {
      slideImages.push(extraImageUrls[i]);
      continue;
    }

    const slidePrompt = slide.image_prompt || `${slide.title} geopolitical documentary photography, atmospheric dark lighting, high contrast chiaroscuro, cinematic void background`;
    try {
      console.log(`[Phase 2.5] Generating image for slide ${i + 1}: "${slidePrompt}"`);
      const slideResult = await imageGenerator({
        prompt: slidePrompt,
        style: 'dramatic',
        aspectRatio: '4:5',
        uploadToS3: true,
      });
      slideImages.push(slideResult.url || coverImageUrl);
    } catch (slideErr) {
      console.warn(`[Phase 2.5] Failed to generate image for slide ${i + 1}, using cover fallback:`, slideErr);
      slideImages.push(coverImageUrl);
    }
  }


  // Phase 3: Highlight Enhancement
  await notifyStatus('✨ Menambahkan highlight teks...');
  
  const highlightText = async (text: string) => {
    try {
      const { text: boldedText } = await generateText({
        model: googleAI('gemini-3.1-flash-lite'),
        system: `You are an editor for an analytical geopolitical Instagram carousel. Add bold markdown (using **text**) to the most critical words, clauses, or territorial concepts.
RULES:
1. Do not change words, only add ** around key highlights.
2. Bold around 20-30% of key phrases to maintain high visual impact.
3. Output ONLY the modified text.`,
        prompt: text
      });
      return boldedText.trim() || text;
    } catch (err) {
      return text;
    }
  };

  const enhancedSlides = await Promise.all(contentParams.slides.map(async (slide, idx) => {
    const alreadyHighlighted = slide.text.includes('**') || slide.text.includes('<strong>');
    const bolded = alreadyHighlighted ? slide.text : await highlightText(slide.text);
    return {
      ...slide,
      text: censorText(bolded, bannedWords),
      slide_image: slideImages[idx] || coverImageUrl
    };
  }));

  const templateData: any = {
    title: censorText(contentParams.title, bannedWords),
    subtitle: censorText(contentParams.subtitle, bannedWords),
    image_prompt: contentParams.image_prompt,
    slides: enhancedSlides,
    source_name: contentParams.source_name,
    source_url: contentParams.source_url,
    coverImageUrl,
    inputImages: extraImageUrls
  };

  // Phase 4: Media Rendering
  await notifyStatus('🖼️ Merender desain carousel...');
  const renderedMedia = await generateCarouselAnalysisMedia(templateData, settings);

  // Phase 5: Queue Insertion
  await notifyStatus('🚀 Menyimpan ke Queue...');
  const [inserted] = await insertQueueItem({
    connectionId: settings.id,
    templateId: carouselAnalysisTemplateConfig.id,
    templateData,
    text: contentParams.finalCaption,
    media: renderedMedia,
    status: 'pending',
    chatId,
    messageId,
    researchResult: research.text,
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

  if (telegram && chatId && renderedMedia.length > 0) {
    try {
      const response = await fetch(renderedMedia[0].url);
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const previewBuffer = Buffer.from(arrayBuffer);
        await withRetry(() => telegram.sendPhoto(chatId, { source: previewBuffer }, {
          caption: contentParams.finalCaption,
          reply_to_message_id: messageId,
          ...postButton
        }));
      }
    } catch (e) {
      await withRetry(() => telegram.sendMessage(chatId, contentParams.finalCaption, { reply_to_message_id: messageId, ...postButton }));
    }
  }

  if (telegram && statusMsg?.chat?.id && statusMsg?.message_id) {
    await withRetry(() => telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id)).catch(() => {});
  }
  console.log(`[Done] Geopolitical Analysis Pipeline finished.`);
  return inserted;
}

export async function generateCarouselAnalysisContent(
  context: PipelineContext,
  insights: Record<string, string>,
  candidateSources?: any[],
  primarySourceUrl?: string | null
): Promise<{
  title: string;
  subtitle: string;
  slides: { type: string; title?: string; text: string; image_prompt?: string }[];
  source_name: string;
  source_url?: string;
  image_prompt: string;
  finalCaption: string;
}> {
  const { userInput, settings, currentDateStr, baseSystemPrompt } = context;
  const defaultGuidelines = `Fokus pada analisis geopolitik realistis: kepentingan wilayah (teritori), sumber daya alam/energi, aliansi militer, rute dagang, dan kalkulasi strategis negara-negara. Hindari narasi simplistik (seperti menganggap konflik geopolitik semata-mata soal sentimen agama atau emosi moral). Buka tabir di balik motif kekuatan besar dengan lugas dan mendalam.`;
  const editorialGuidelines = settings?.editorialGuidelines || defaultGuidelines;
  const bannedWords = settings?.bannedWords || [];

  const bannedWordsPrompt = bannedWords.length > 0 
    ? `\n\nCRITICAL MODERATION RULE:\nReplace sensitive words with safe alternatives:\n${bannedWords.map((w: any) => `- Replace "${w.word}" with "${w.replacement}"`).join('\n')}`
    : '';

  const isScriptMode = isStructuredSlideScript(userInput);

  const scriptModePrompt = `
You are a strict, zero-alteration formatter and visual prompt generator for an Instagram Carousel script.
The user has provided a finished multi-slide script. DO NOT rewrite, formalize, or replace ANY of the user's words or sentences with synonyms!

STRICT VERBATIM RULES:
1. SLIDE 1 BECOMES THE COVER (` + '`title` & `subtitle`' + `):
   - ` + '`title`' + `: Copy Slide 1's Headline WORD-FOR-WORD (in UPPERCASE). Remove emojis only. Wrap 1-3 key words in <strong>...</strong> for amber highlight.
   - ` + '`subtitle`' + `: Copy Slide 1's Teks WORD-FOR-WORD. Remove emojis (like ⬇️) only. Do not change a single word!
2. SLIDES 2..N BECOME BODY SLIDES (` + '`slides` array' + `):
   - Map Slide 2, Slide 3, ... Slide N in exact 1-to-1 order into ` + '`slides`' + ` (unless a single slide is > 600 chars, in which case split that slide into 2 consecutive slides at a sentence boundary without changing any words).
   - ` + '`slide.title`' + `: Copy that slide's Headline WORD-FOR-WORD (keep casual words like "Itu Apa Sih?", "Jauh di Mata, Terasa Dampaknya", etc. EXACTLY as written!). Remove emojis only, and wrap 1-2 key words in <strong>...</strong>.
   - ` + '`slide.text`' + `: Copy that slide's Teks WORD-FOR-WORD, CHARACTER-FOR-CHARACTER!
     * FORBIDDEN: NEVER replace casual words ("punya kuasa penuh", "Ujung-ujungnya", "bengkak", "jor-joran", "jalan di tempat", "ikut panik") with formal words!
     * ALLOWED ONLY:
       a) Add **bold** markdown around 20-30% of key phrases inside the existing words.
       b) Insert a single "<br/>" between sentence groups so the slide has 2 clean paragraphs.
       c) Remove emojis from the visual slide text.
3. AUTOMATIC AI IMAGE PROMPTS:
   - Generate a specific, atmospheric English ` + '`image_prompt`' + ` for the Cover and for EVERY slide in ` + '`slides`' + `.
   - Style: dark editorial geopolitical photography, dramatic chiaroscuro lighting, concrete visual subjects matching that specific slide's topic. NO TEXT or words in the image prompt.
`;

  const dynamicSystemPromptAdditions = isScriptMode ? scriptModePrompt : `
Your task is to craft an in-depth geopolitical analysis Instagram carousel with EXACTLY 1 COVER + 8 SLIDES.
Adopt a pop-intellectual, engaging, and articulate Indonesian voice (Tier 2 Semi-Formal / Essayist style).

CRITICAL TONE & GRAMMAR RULES:
1. Use natural, conversational collective pronouns: "kita", "di sekitar kita", "cara pandang kita".
2. Use organic conversational transitions: "Singkatnya,", "Nah, kebiasaan inilah yang...", "Padahal,", "Contoh paling nyata:".
3. NO AI clichés: NEVER use "Di era modern/globalisasi ini", "Sangat krusial untuk dicatat", "Tidak dapat dipungkiri bahwa", "Merupakan salah satu yang paling", "Sebagai kesimpulan".
4. ZERO DASHES: NEVER use em dashes (—) or en dashes (–). Use commas, colons (:), periods, or parentheses ( ) instead.
5. Each slide body text MUST contain EXACTLY 2 short paragraphs (1-2 punchy sentences each), separated by a single "<br/>".
6. Bold around 20-30% of pivotal keywords, actor names, and strategic concepts using markdown: **keyword**.
7. Slide titles MUST be punchy uppercase phrases (3-5 words), highlighting the key punchy word with <strong>...</strong> (this turns amber in the Bebas Neue font).
8. PRESERVE DIRECT QUOTES VERBATIM: If the user input contains a direct quote (kutipan pidato/tokoh) in quotation marks ("..."), YOU MUST KEEP THE EXACT QUOTE in quotation marks ("..."). DO NOT paraphrase or convert direct quotes into indirect narrative summary! Let the raw words of the quote stand out.

HOW TO STRUCTURE THE CAROUSEL:

[RULE 1: EXPLICIT USER INPUT / DRAFT BYPASS]
If the user's input already provides specific points, a raw draft, slide-by-slide text (e.g. "Slide 1: ... Slide 2: ..."), specific analogies (e.g. "ruang kelas tanpa guru", quotes, specific conflicts, or custom arguments):
-> DO NOT force the default generic story arc below!
-> STRICTLY prioritize and preserve the user's core ideas, analogies, quotes, and specific case studies.
-> Your job is simply to rewrite, polish, and format their specific thoughts into Cover + Body Slides following the required styling (Bebas Neue uppercase titles with <strong>...</strong> amber highlights, 2 short paragraphs per slide separated by "<br/>", markdown **bold** highlights, and tailored visual image prompts).

[RULE 2: AUTONOMOUS TOPIC-ONLY MODE]
If the user only provides a general topic, headline, or URL without a slide-by-slide draft:
-> Create a dynamic, engaging 8-slide geopolitical essay arc tailored uniquely to that subject.
-> DO NOT be formulaic or repetitive across different posts. Adapt the flow to the specific topic:
   * Cover: Provocative title with <strong>...</strong> on the punchy word + intrigue subtitle.
   * Slide 1-2: Hook & Reframe / The Deconstruction (question the mainstream illusion or lay out the raw premise).
   * Slide 3-4: The Core Mechanism / Interests (unveil the real material interests: geographic chokepoints, supply chains, energy, or sovereignty).
   * Slide 5-6: Empirical Case / Power Dynamics (concrete countries, proxy networks, or strategic trade-offs).
   * Slide 7-8: Critical Implication & The Reality Check (why it matters to the reader, and a punchy thought-provoking takeaway).
-> Vary your title patterns and transitions so every carousel feels fresh, original, and deeply insightful.
`;
  const slideSchema = z.object({
    type: z.literal('opinion').default('opinion'),
    title: z.string().describe('Slide heading in Bebas Neue (NO emojis). Bold key words with <strong> for amber accent.'),
    text: z.string().describe('Body paragraph in Alumni Sans (2 paragraphs separated by <br/>, key phrases bolded with **keyword**).'),
    image_prompt: z.string().describe('Atmospheric English visual prompt for this slide background, e.g. "US Capitol dome under dark moody storm clouds, editorial photography". NO TEXT.')
  });

  const schema = z.object({
    title: z.string().describe('Cover headline in Bebas Neue (NO emojis). Wrap key words in <strong>...</strong> for amber highlight.'),
    subtitle: z.string().describe('Cover subtitle in Alumni Sans.'),
    slides: isScriptMode ? z.array(slideSchema).min(1).max(16) : z.array(slideSchema).length(8),
    source_name: z.string(),
    source_url: z.string().optional(),
    image_prompt: z.string().describe('Atmospheric English visual prompt for the Cover background. NO TEXT.')
  });

  const writerSystemPrompt = isScriptMode
    ? `${scriptModePrompt}${bannedWordsPrompt}`
    : baseSystemPrompt + `\n\nEDITORIAL GUIDELINES & FRAMING:\n${editorialGuidelines}\n\n${dynamicSystemPromptAdditions}` + bannedWordsPrompt;
  const insightsPrompt = buildPromptContextFromInsights(insights);

  const { object: contentParams } = await generateObject({
    model: googleAI(process.env.CONTENT_WRITER_MODEL || 'gemini-3.1-pro-preview'),
    system: writerSystemPrompt,
    schema,
    prompt: `Original User Input/Topic:\n${userInput}\n\nGathered Insights:\n${insightsPrompt || ''}${candidateSources && candidateSources.length > 0 ? '\n\nCandidate Source URLs:\n' + candidateSources.map((c: any) => `- ${c.title || c.domain || ''}: ${c.url}`).join('\n') : ''}`,
  });

  const cleanForCaption = (str: string) =>
    str
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .trim();

  let finalCaption = `${cleanForCaption(contentParams.title)}\n\n${cleanForCaption(contentParams.subtitle)}\n\n` +
    contentParams.slides.map((s, idx) => `[${idx + 1}] ${cleanForCaption(s.title)}\n${cleanForCaption(s.text)}`).join('\n\n') +
    `\n\n${currentDateStr}. Sumber: ${contentParams.source_name}`;
  finalCaption = censorText(finalCaption, bannedWords);
  return {
    title: contentParams.title,
    subtitle: contentParams.subtitle,
    slides: contentParams.slides,
    source_name: contentParams.source_name,
    source_url: contentParams.source_url || primarySourceUrl || undefined,
    image_prompt: contentParams.image_prompt,
    finalCaption
  };
}
