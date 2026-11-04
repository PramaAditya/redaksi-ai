import { z } from 'zod';

export interface RedaksiClientConfig {
  apiUrl: string;
  apiKey: string;
}

export function getDefaultClientConfig(): RedaksiClientConfig {
  const apiUrl = (
    process.env.REDAKSI_API_URL ||
    process.env.APP_URL ||
    'https://ignewsbot.rekapancatama.com'
  ).replace(/\/$/, '');
  const apiKey = process.env.REDAKSI_API_KEY || process.env.DASHBOARD_PASSWORD || '';
  return { apiUrl, apiKey };
}

export async function apiRequest<T = any>(
  path: string,
  options: RequestInit = {},
  config: RedaksiClientConfig = getDefaultClientConfig()
): Promise<T> {
  if (!config.apiKey) {
    throw new Error('Missing REDAKSI_API_KEY or DASHBOARD_PASSWORD in environment.');
  }
  const url = `${config.apiUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Redaksi API Error (${res.status} on ${path}): ${data?.error || data?.details || text}`);
  }
  return data as T;
}

export interface RedaksiToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  label: string;
  description: string;
  schema: TSchema;
  execute: (params: z.infer<TSchema>, config?: RedaksiClientConfig) => Promise<any>;
}

export const REDAKSI_MCP_TOOLS: RedaksiToolDefinition<any>[] = [
  // ============================================================================
  // DOMAIN 1: ACCOUNT, BRAND, SCHEDULE & CENSORSHIP MANAGEMENT
  // ============================================================================
  {
    name: 'redaksi_list_accounts',
    label: 'Redaksi.AI: List Accounts',
    description:
      'List all Instagram account connections in Redaksi.AI along with summary metadata (Buffer channel, posting slot count, banned word count, and News Radar mode).',
    schema: z.object({}),
    async execute(_params, config) {
      const connections = await apiRequest<any[]>('/api/connections', {}, config);
      const summaries = connections.map((c) => ({
        id: c.id,
        name: c.name,
        network: c.bufferChannelNetwork || 'instagram',
        hasBufferCredentials: Boolean(c.bufferApiKey && c.bufferChannelId),
        logoImageUrl: c.logoImageUrl || null,
        ctaImageUrl: c.ctaImageUrl || null,
        postingSlotsCount: Array.isArray(c.postingSlots) ? c.postingSlots.length : 0,
        bannedWordsCount: Array.isArray(c.bannedWords) ? c.bannedWords.length : 0,
        newsRadarMode: c.newsRadarConfig?.mode || 'off',
        newsRadarKeywords: c.newsRadarConfig?.keywords || [],
      }));
      return { count: summaries.length, accounts: summaries };
    },
  },

  {
    name: 'redaksi_get_account',
    label: 'Redaksi.AI: Get Account Details',
    description:
      'Get the complete configuration of a specific account connection (editorialGuidelines, postingSlots, bannedWords, newsRadarConfig, logoImageUrl, ctaImageUrl).',
    schema: z.object({
      connectionId: z.number().describe('The numeric connection ID of the account.'),
    }),
    async execute({ connectionId }, config) {
      const connections = await apiRequest<any[]>('/api/connections', {}, config);
      const account = connections.find((c) => c.id === Number(connectionId));
      if (!account) throw new Error(`Account connection #${connectionId} not found.`);
      return account;
    },
  },

  {
    name: 'redaksi_create_account',
    label: 'Redaksi.AI: Create Account Connection',
    description:
      'Create a new social media account connection in Redaksi.AI with optional Buffer credentials, editorial guidelines, and brand assets.',
    schema: z.object({
      name: z.string().describe('Account display name (e.g. "AA Geopolitik" or "Poros Perjuangan").'),
      bufferApiKey: z.string().optional().describe('Optional Buffer API access token.'),
      bufferChannelId: z.string().optional().describe('Optional Buffer Channel ID.'),
      editorialGuidelines: z.string().optional().describe('Editorial persona, framing stance, and writing tone.'),
      logoImageUrl: z.string().optional().describe('URL to brand watermark logo PNG.'),
      ctaImageUrl: z.string().optional().describe('URL to final Call-To-Action slide image.'),
    }),
    async execute(params, config) {
      const created = await apiRequest('/api/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: params.name,
          bufferApiKey: params.bufferApiKey,
          bufferChannelId: params.bufferChannelId,
        }),
      }, config);

      const connId = created?.connection?.id;
      if (connId && (params.editorialGuidelines || params.logoImageUrl || params.ctaImageUrl)) {
        await apiRequest(`/api/connections/${connId}`, {
          method: 'PUT',
          body: JSON.stringify({
            editorialGuidelines: params.editorialGuidelines,
            logoImageUrl: params.logoImageUrl,
            ctaImageUrl: params.ctaImageUrl,
          }),
        }, config);
      }
      return created;
    },
  },

  {
    name: 'redaksi_update_account',
    label: 'Redaksi.AI: Update Account Settings',
    description:
      'Update any account connection setting in the database: name, logoImageUrl, ctaImageUrl, editorialGuidelines, Buffer credentials, or cron hours.',
    schema: z.object({
      connectionId: z.number().describe('The account connection ID to update.'),
      name: z.string().optional().describe('New account display name.'),
      logoImageUrl: z.string().optional().describe('New watermark logo URL.'),
      ctaImageUrl: z.string().optional().describe('New CTA end-slide image URL.'),
      editorialGuidelines: z.string().optional().describe('Updated editorial guidelines / persona instructions.'),
      bufferApiKey: z.string().optional().describe('Updated Buffer API Key.'),
      bufferChannelId: z.string().optional().describe('Updated Buffer Channel ID.'),
      cronIntervalMinutes: z.number().optional(),
      cronStartHour: z.number().optional(),
      cronEndHour: z.number().optional(),
    }),
    async execute({ connectionId, ...updates }, config) {
      return apiRequest(`/api/connections/${connectionId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }, config);
    },
  },

  {
    name: 'redaksi_manage_posting_slots',
    label: 'Redaksi.AI: Manage Posting Slots',
    description:
      'View, set explicitly, clear, or generate posting schedule slots using natural language AI (e.g. "Every day at 08:30, 13:00, and 19:30 WIB").',
    schema: z.object({
      connectionId: z.number().describe('The account connection ID.'),
      action: z
        .enum(['get', 'set', 'generate_ai', 'clear'])
        .describe('Action to perform on the account posting slots.'),
      prompt: z
        .string()
        .optional()
        .describe('Natural language schedule instruction when action="generate_ai".'),
      slots: z
        .array(
          z.object({
            day: z.enum(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']),
            time: z.string().describe('24-hour HH:mm time in WIB (e.g. "09:00", "19:30").'),
          })
        )
        .optional()
        .describe('Explicit array of slots when action="set".'),
    }),
    async execute({ connectionId, action, prompt, slots }, config) {
      if (action === 'get') {
        const connections = await apiRequest<any[]>('/api/connections', {}, config);
        const conn = connections.find((c) => c.id === Number(connectionId));
        if (!conn) throw new Error(`Connection #${connectionId} not found.`);
        return { connectionId, postingSlots: conn.postingSlots || [] };
      }
      if (action === 'generate_ai') {
        if (!prompt) throw new Error('prompt is required when action="generate_ai".');
        return apiRequest(`/api/connections/${connectionId}/slots/generate`, {
          method: 'POST',
          body: JSON.stringify({ prompt }),
        }, config);
      }
      const nextSlots = action === 'clear' ? [] : slots || [];
      await apiRequest(`/api/connections/${connectionId}`, {
        method: 'PUT',
        body: JSON.stringify({ postingSlots: nextSlots }),
      }, config);
      return { message: `Posting slots updated (${nextSlots.length} slots).`, postingSlots: nextSlots };
    },
  },

  {
    name: 'redaksi_manage_banned_words',
    label: 'Redaksi.AI: Manage Banned Words & Censorship',
    description:
      'List, add, remove, or copy/merge censorship word rules (exact or partial match replacements) for an account.',
    schema: z.object({
      connectionId: z.number().describe('The target account connection ID.'),
      action: z
        .enum(['list', 'add', 'remove', 'copy_from_account'])
        .describe('Operation to perform on bannedWords.'),
      rules: z
        .array(
          z.object({
            word: z.string(),
            replacement: z.string().default('***'),
            type: z.enum(['exact', 'partial']).default('partial'),
          })
        )
        .optional()
        .describe('Word rules to add when action="add".'),
      wordsToRemove: z
        .array(z.string())
        .optional()
        .describe('Words to delete when action="remove".'),
      sourceConnectionId: z
        .number()
        .optional()
        .describe('Source account ID when action="copy_from_account".'),
      copyMode: z
        .enum(['merge', 'overwrite'])
        .optional()
        .default('merge')
        .describe('Whether to merge or overwrite rules when copying from another account.'),
    }),
    async execute({ connectionId, action, rules, wordsToRemove, sourceConnectionId, copyMode = 'merge' }, config) {
      const connections = await apiRequest<any[]>('/api/connections', {}, config);
      const target = connections.find((c) => c.id === Number(connectionId));
      if (!target) throw new Error(`Connection #${connectionId} not found.`);
      let currentWords: { word: string; replacement: string; type: 'exact' | 'partial' }[] = Array.isArray(
        target.bannedWords
      )
        ? [...target.bannedWords]
        : [];

      if (action === 'list') {
        return { connectionId, count: currentWords.length, bannedWords: currentWords };
      }

      if (action === 'add' && Array.isArray(rules)) {
        for (const r of rules) {
          const idx = currentWords.findIndex((w) => w.word.toLowerCase() === r.word.toLowerCase().trim());
          const entry = {
            word: r.word.trim(),
            replacement: r.replacement?.trim() || '***',
            type: r.type || 'partial',
          };
          if (idx >= 0) currentWords[idx] = entry;
          else currentWords.push(entry);
        }
      } else if (action === 'remove' && Array.isArray(wordsToRemove)) {
        const removeSet = new Set(wordsToRemove.map((w) => w.toLowerCase().trim()));
        currentWords = currentWords.filter((w) => !removeSet.has(w.word.toLowerCase().trim()));
      } else if (action === 'copy_from_account') {
        const src = connections.find((c) => c.id === Number(sourceConnectionId));
        if (!src) throw new Error(`Source connection #${sourceConnectionId} not found.`);
        const srcWords = Array.isArray(src.bannedWords) ? src.bannedWords : [];
        if (copyMode === 'overwrite') {
          currentWords = [...srcWords];
        } else {
          const existingLower = new Set(currentWords.map((w) => w.word.toLowerCase()));
          for (const sw of srcWords) {
            if (!existingLower.has(sw.word.toLowerCase())) {
              currentWords.push(sw);
            }
          }
        }
      }

      await apiRequest(`/api/connections/${connectionId}`, {
        method: 'PUT',
        body: JSON.stringify({ bannedWords: currentWords }),
      }, config);

      return { connectionId, count: currentWords.length, bannedWords: currentWords };
    },
  },

  {
    name: 'redaksi_delete_account',
    label: 'Redaksi.AI: Delete Account Connection',
    description: 'Delete an account connection and all of its associated queue items, ideas, and jobs.',
    schema: z.object({
      connectionId: z.number().describe('The account connection ID to delete.'),
    }),
    async execute({ connectionId }, config) {
      return apiRequest(`/api/connections/${connectionId}`, { method: 'DELETE' }, config);
    },
  },

  // ============================================================================
  // DOMAIN 2: NEWSROOM RADAR & IDEA DESK
  // ============================================================================
  {
    name: 'redaksi_configure_news_radar',
    label: 'Redaksi.AI: Configure News Radar & Autopilot',
    description:
      'Configure the Autonomous News Radar for an account (mode: off | semi_auto | autopilot, topic keywords for Google News RSS, language: id | en, customRssUrls, scan intervalHours, and autopilot minPendingQueueThreshold).',
    schema: z.object({
      connectionId: z.number().describe('The account connection ID.'),
      mode: z.enum(['off', 'semi_auto', 'autopilot']).optional(),
      keywords: z.array(z.string()).optional().describe('Replace the entire topic keywords list.'),
      addKeywords: z.array(z.string()).optional().describe('Append new topic keywords without erasing existing ones.'),
      removeKeywords: z.array(z.string()).optional().describe('Remove specific topic keywords.'),
      language: z.enum(['id', 'en']).optional(),
      customRssUrls: z.array(z.string()).optional().describe('Custom RSS feed URLs.'),
      intervalHours: z.number().min(1).max(48).optional(),
      maxStoriesPerScan: z.number().min(1).max(5).optional(),
      minPendingQueueThreshold: z.number().min(1).max(20).optional(),
      defaultTemplateId: z.string().optional(),
      defaultHeroStyle: z.enum(['Dark-Dramatize', '4K-Enhance']).optional(),
    }),
    async execute(params, config) {
      const connections = await apiRequest<any[]>('/api/connections', {}, config);
      const conn = connections.find((c) => c.id === Number(params.connectionId));
      if (!conn) throw new Error(`Connection #${params.connectionId} not found.`);

      const existingRadar = conn.newsRadarConfig || {
        mode: 'off',
        keywords: [],
        language: 'id',
        customRssUrls: [],
        intervalHours: 4,
        minPendingQueueThreshold: 2,
        defaultTemplateId: 'image:aa.geopolitik:carousel_analysis',
        defaultHeroStyle: 'Dark-Dramatize',
        maxStoriesPerScan: 3,
      };

      let nextKeywords: string[] = params.keywords
        ? [...params.keywords]
        : Array.isArray(existingRadar.keywords)
          ? [...existingRadar.keywords]
          : [];

      if (params.addKeywords?.length) {
        for (const kw of params.addKeywords) {
          if (!nextKeywords.some((k) => k.toLowerCase() === kw.toLowerCase().trim())) {
            nextKeywords.push(kw.trim());
          }
        }
      }
      if (params.removeKeywords?.length) {
        const rem = new Set(params.removeKeywords.map((k) => k.toLowerCase().trim()));
        nextKeywords = nextKeywords.filter((k) => !rem.has(k.toLowerCase().trim()));
      }

      const nextRadarConfig = {
        ...existingRadar,
        ...(params.mode !== undefined ? { mode: params.mode } : {}),
        keywords: nextKeywords,
        ...(params.language !== undefined ? { language: params.language } : {}),
        ...(params.customRssUrls !== undefined ? { customRssUrls: params.customRssUrls } : {}),
        ...(params.intervalHours !== undefined ? { intervalHours: params.intervalHours } : {}),
        ...(params.maxStoriesPerScan !== undefined ? { maxStoriesPerScan: params.maxStoriesPerScan } : {}),
        ...(params.minPendingQueueThreshold !== undefined
          ? { minPendingQueueThreshold: params.minPendingQueueThreshold }
          : {}),
        ...(params.defaultTemplateId !== undefined ? { defaultTemplateId: params.defaultTemplateId } : {}),
        ...(params.defaultHeroStyle !== undefined ? { defaultHeroStyle: params.defaultHeroStyle } : {}),
      };

      await apiRequest(`/api/connections/${params.connectionId}`, {
        method: 'PUT',
        body: JSON.stringify({ newsRadarConfig: nextRadarConfig }),
      }, config);

      return { connectionId: params.connectionId, newsRadarConfig: nextRadarConfig };
    },
  },

  {
    name: 'redaksi_scan_breaking_news',
    label: 'Redaksi.AI: Scan Breaking News (AI Chief Editor)',
    description:
      'Trigger an immediate RSS + Google News scan for an account. Performs 2-stage deduplication against past posts, clusters multi-source links covering the same story, and returns the top viral story candidates with AI Chief Editor pitches.',
    schema: z.object({
      connectionId: z.number().describe('The account connection ID to scan news for.'),
      maxStories: z.number().min(1).max(5).optional().describe('Max number of top stories to pick (1-5).'),
    }),
    async execute({ connectionId, maxStories }, config) {
      return apiRequest('/api/ideas/scan-news', {
        method: 'POST',
        body: JSON.stringify({ connectionId, maxStories }),
      }, config);
    },
  },

  {
    name: 'redaksi_list_ideas',
    label: 'Redaksi.AI: List Newsroom Ideas',
    description:
      'List story ideas on the Newsroom Desk filtered by connectionId, status (pending, converted, rejected), and source (all, radar, telegram).',
    schema: z.object({
      connectionId: z.number().optional().describe('Filter by account connection ID.'),
      status: z.enum(['pending', 'converted', 'rejected']).optional().default('pending'),
      source: z.enum(['all', 'radar', 'telegram']).optional().default('all'),
    }),
    async execute({ connectionId, status = 'pending', source = 'all' }, config) {
      let query = `?status=${encodeURIComponent(status)}`;
      if (connectionId) query += `&connectionId=${encodeURIComponent(String(connectionId))}`;
      const ideas = await apiRequest<any[]>(`/api/ideas${query}`, {}, config);
      const filtered = ideas.filter((i) => {
        const isRadar = i?.metadata?.sourceType === 'radar' || i?.chatId === 'NEWS_RADAR';
        if (source === 'radar') return isRadar;
        if (source === 'telegram') return !isRadar;
        return true;
      });
      return { count: filtered.length, ideas: filtered };
    },
  },

  {
    name: 'redaksi_manage_idea',
    label: 'Redaksi.AI: Manage Idea (Create / Convert / Reject)',
    description:
      'Create a new story idea, convert an existing idea into an active Carousel generation job (with templateId and heroStyle), move a converted/rejected idea back to pending review (restore / move_to_pending), or mark an idea as rejected/deleted.',
    schema: z.object({
      action: z.enum(['create', 'convert', 'reject', 'restore', 'move_to_pending', 'delete']),
      ideaId: z.number().optional().describe('Required for convert, reject, restore, move_to_pending, or delete.'),
      connectionId: z.number().optional().describe('Required when action="create".'),
      text: z.string().optional().describe('Idea text, topic, or URLs when action="create".'),
      templateId: z
        .string()
        .optional()
        .describe('Template ID when action="convert" (e.g. "image:aa.geopolitik:carousel_analysis").'),
      heroStyle: z
        .enum(['Dark-Dramatize', '4K-Enhance'])
        .optional()
        .default('Dark-Dramatize')
        .describe('Cover visual style when action="convert".'),
    }),
    async execute({ action, ideaId, connectionId, text, templateId, heroStyle }, config) {
      if (action === 'create') {
        if (!connectionId || !text) throw new Error('connectionId and text are required when action="create".');
        return apiRequest('/api/ideas', {
          method: 'POST',
          body: JSON.stringify({ connectionId, text }),
        }, config);
      }
      if (!ideaId) throw new Error(`ideaId is required for action="${action}".`);
      if (action === 'convert') {
        return apiRequest(`/api/ideas/${ideaId}/convert`, {
          method: 'POST',
          body: JSON.stringify({ templateId, heroStyle }),
        }, config);
      }
      if (action === 'delete') {
        return apiRequest(`/api/ideas/${ideaId}`, { method: 'DELETE' }, config);
      }
      const nextStatus = action === 'reject' ? 'rejected' : 'pending';
      return apiRequest(`/api/ideas/${ideaId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: nextStatus }),
      }, config);
    },
  },

  // ============================================================================
  // DOMAIN 3: CAROUSEL CREATION ENGINE
  // ============================================================================
  {
    name: 'redaksi_list_templates',
    label: 'Redaksi.AI: List Carousel Templates',
    description:
      'List all available carousel templates in Redaksi.AI along with their IDs, descriptions, and slide UI schemas.',
    schema: z.object({}),
    async execute(_params, config) {
      return apiRequest('/api/templates', {}, config);
    },
  },

  {
    name: 'redaksi_generate_from_topic',
    label: 'Redaksi.AI: Generate Carousel from Topic or URL',
    description:
      'Enqueue an autonomous carousel generation job from a news topic, URL, or multi-URL prompt. The worker performs 5W1H research, opinion synthesis, slide copywriting, parallel AI image generation, and Puppeteer PNG rendering.',
    schema: z.object({
      connectionId: z.number().describe('Target account connection ID.'),
      text: z.string().describe('News topic, instructions, or article URL(s).'),
      templateId: z
        .string()
        .optional()
        .default('image:aa.geopolitik:carousel_analysis')
        .describe('Template ID to use.'),
      mediaUrls: z.array(z.string()).optional().describe('Optional reference or album image URLs.'),
    }),
    async execute({ connectionId, text, templateId, mediaUrls }, config) {
      return apiRequest('/api/generate-content', {
        method: 'POST',
        body: JSON.stringify({ connectionId, text, templateId, mediaUrls }),
      }, config);
    },
  },

  {
    name: 'redaksi_create_from_script',
    label: 'Redaksi.AI: Create Carousel from Verbatim Script',
    description:
      'Create a multi-slide Instagram carousel from a structured script (Slide 1 = Cover title+subtitle, Slide 2..N = body slides with minimal text changes). Optionally generates all AI slide background images in parallel and renders 1080x1350 PNGs immediately.',
    schema: z.object({
      connectionId: z.number().describe('Target account connection ID (e.g. 5 for AA Geopolitik).'),
      script: z
        .string()
        .describe('Full multi-slide script text (e.g. "Slide 1\\nHeadline: ...\\nTeks: ...\\nSlide 2...").'),
      templateId: z
        .string()
        .optional()
        .default('image:aa.geopolitik:carousel_analysis')
        .describe('Template ID.'),
      generateImages: z
        .boolean()
        .optional()
        .default(true)
        .describe('If true, generates AI cover & slide backgrounds in parallel and renders final 1080x1350 PNGs.'),
      status: z
        .enum(['draft', 'pending'])
        .optional()
        .default('pending')
        .describe('Initial queue status.'),
    }),
    async execute({ connectionId, script, templateId, generateImages = true, status = 'pending' }, config) {
      const created = await apiRequest<any>('/api/queue/from-script', {
        method: 'POST',
        body: JSON.stringify({
          connectionId,
          templateId,
          text: script,
          generateImages: false,
          status,
        }),
      }, config);

      const postId = created?.item?.id;
      if (!postId || !generateImages) {
        return created;
      }

      const withImages = await apiRequest<any>(`/api/queue/${postId}/generate-slide-image`, {
        method: 'POST',
        body: JSON.stringify({
          target: 'all',
          renderMedia: true,
        }),
      }, config);

      return {
        message: 'Carousel created from script, AI images generated in parallel, and 1080x1350 PNGs rendered.',
        postId,
        slideCount: created.slideCount,
        media: withImages.media,
        templateData: withImages.templateData,
      };
    },
  },

  {
    name: 'redaksi_create_manual_post',
    label: 'Redaksi.AI: Create Manual Post',
    description: 'Add a pre-rendered image or carousel post directly to an account queue with caption and optional schedule.',
    schema: z.object({
      connectionId: z.number().describe('Target account connection ID.'),
      caption: z.string().describe('Instagram post caption text.'),
      imageUrls: z.array(z.string()).min(1).describe('Array of image URLs in slide order.'),
      scheduledAt: z.string().optional().describe('Optional ISO-8601 timestamp for custom scheduling.'),
    }),
    async execute({ connectionId, caption, imageUrls, scheduledAt }, config) {
      return apiRequest('/api/queue', {
        method: 'POST',
        body: JSON.stringify({
          connectionId,
          text: caption,
          media: imageUrls.map((url) => ({ type: 'image', url })),
          scheduledAt,
        }),
      }, config);
    },
  },

  // ============================================================================
  // DOMAIN 4: GRANULAR SLIDE STUDIO & PER-SLIDE AI IMAGE REGENERATION
  // ============================================================================
  {
    name: 'redaksi_get_post',
    label: 'Redaksi.AI: Get Post & Slides Detail',
    description:
      'Fetch complete details of a queue post by ID, including title, subtitle, every slide (title, text, image_prompt, slide_image), editorial agentInsights, caption text, and rendered 1080x1350 PNG URLs.',
    schema: z.object({
      postId: z.number().describe('The queue post ID.'),
    }),
    async execute({ postId }, config) {
      return apiRequest(`/api/queue/${postId}`, {}, config);
    },
  },

  {
    name: 'redaksi_update_post',
    label: 'Redaksi.AI: Update Post & Slides',
    description:
      'Surgically edit a post in the queue: update cover title/subtitle/image_prompt/coverImageUrl, edit individual slides by slideIndex, add/remove/reorder slides, update the Instagram caption, or update agentInsights. Optionally re-renders the 1080x1350 PNGs immediately.',
    schema: z.object({
      postId: z.number().describe('The queue post ID to update.'),
      title: z.string().optional().describe('Updated cover headline (supports **bold** for highlight).'),
      subtitle: z.string().optional().describe('Updated cover subtitle.'),
      image_prompt: z.string().optional().describe('Updated English AI image prompt for the cover.'),
      coverImageUrl: z.string().optional().describe('Updated cover background image URL.'),
      source_name: z.string().optional(),
      source_url: z.string().optional(),
      caption: z.string().optional().describe('Updated final Instagram caption text.'),
      status: z.enum(['pending', 'draft']).optional(),
      agentInsights: z.record(z.string(), z.string()).optional().describe('Updated research/opinion notes.'),
      slideUpdates: z
        .array(
          z.object({
            slideIndex: z.number().describe('0-based body slide index (0 = Slide 1, 1 = Slide 2, etc.).'),
            title: z.string().optional().describe('Updated slide headline (supports **bold**).'),
            text: z.string().optional().describe('Updated slide body paragraph text (supports **bold**).'),
            image_prompt: z.string().optional().describe('Updated English AI background prompt for this slide.'),
            slide_image: z.string().optional().describe('Updated background image URL for this slide.'),
            imageUrl: z.string().optional().describe('Updated full-slide image URL (if type="image").'),
            type: z.string().optional().describe('Slide type (e.g. "opinion", "news", "text", "image").'),
          })
        )
        .optional()
        .describe('Patch specific body slides by 0-based index without touching other slides.'),
      addSlides: z
        .array(
          z.object({
            type: z.string().optional().default('opinion'),
            title: z.string().optional(),
            text: z.string().optional(),
            image_prompt: z.string().optional(),
            slide_image: z.string().optional(),
          })
        )
        .optional()
        .describe('Append new body slides to the end of the carousel.'),
      removeSlideIndices: z
        .array(z.number())
        .optional()
        .describe('0-based indices of body slides to delete.'),
      renderMedia: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, immediately re-renders all 1080x1350 PNG slides via Puppeteer after saving.'),
    }),
    async execute(params, config) {
      const post = await apiRequest<any>(`/api/queue/${params.postId}`, {}, config);
      const templateData: Record<string, any> = { ...(post.templateData || {}) };

      if (params.title !== undefined) templateData.title = params.title;
      if (params.subtitle !== undefined) templateData.subtitle = params.subtitle;
      if (params.image_prompt !== undefined) templateData.image_prompt = params.image_prompt;
      if (params.coverImageUrl !== undefined) templateData.coverImageUrl = params.coverImageUrl;
      if (params.source_name !== undefined) templateData.source_name = params.source_name;
      if (params.source_url !== undefined) templateData.source_url = params.source_url;

      const slides: any[] = Array.isArray(templateData.slides) ? [...templateData.slides] : [];

      if (params.slideUpdates?.length) {
        for (const patch of params.slideUpdates) {
          const idx = patch.slideIndex;
          if (idx >= 0 && idx < slides.length) {
            const current = typeof slides[idx] === 'object' ? { ...slides[idx] } : { text: String(slides[idx]) };
            if (patch.title !== undefined) current.title = patch.title;
            if (patch.text !== undefined) current.text = patch.text;
            if (patch.image_prompt !== undefined) current.image_prompt = patch.image_prompt;
            if (patch.slide_image !== undefined) current.slide_image = patch.slide_image;
            if (patch.imageUrl !== undefined) current.imageUrl = patch.imageUrl;
            if (patch.type !== undefined) current.type = patch.type;
            slides[idx] = current;
          }
        }
      }

      if (params.removeSlideIndices?.length) {
        const toRemove = new Set(params.removeSlideIndices);
        templateData.slides = slides.filter((_, idx) => !toRemove.has(idx));
      } else {
        templateData.slides = slides;
      }

      if (params.addSlides?.length) {
        templateData.slides.push(...params.addSlides);
      }

      await apiRequest(`/api/queue/${params.postId}`, {
        method: 'PUT',
        body: JSON.stringify({
          text: params.caption !== undefined ? params.caption : post.text,
          templateData,
          status: params.status !== undefined ? params.status : post.status,
          agentInsights: params.agentInsights !== undefined ? params.agentInsights : post.agentInsights,
        }),
      }, config);

      if (params.renderMedia) {
        const rendered = await apiRequest(`/api/queue/${params.postId}/regenerate-media`, {
          method: 'POST',
        }, config);
        return {
          message: 'Post updated and 1080x1350 PNG media re-rendered.',
          postId: params.postId,
          media: rendered.media,
          templateData,
        };
      }

      return {
        message: 'Post updated successfully.',
        postId: params.postId,
        templateData,
      };
    },
  },

  {
    name: 'redaksi_generate_slide_image',
    label: 'Redaksi.AI: Generate / Regenerate AI Slide Image(s)',
    description:
      'Generate or regenerate AI background images for a post cover, a single slide (slideIndex), multiple specific slides in parallel (slideIndices), or all slides at once (target="all"). Supports custom prompts, automatic prompt rewriting from slide text (autoRewritePrompt=true), style selection (dramatic/realistic/custom), and instant Puppeteer PNG re-rendering (renderMedia=true).',
    schema: z.object({
      postId: z.number().describe('The queue post ID.'),
      target: z
        .enum(['cover', 'slide', 'slides', 'all'])
        .default('slide')
        .describe('Which image(s) to regenerate: "cover", "slide" (1 slide), "slides" (multiple slides), or "all".'),
      slideIndex: z
        .number()
        .optional()
        .describe('0-based body slide index when target="slide" (0 = Slide 1, 1 = Slide 2, etc.).'),
      slideIndices: z
        .array(z.number())
        .optional()
        .describe('Array of 0-based body slide indices to regenerate in parallel when target="slides".'),
      prompt: z
        .string()
        .optional()
        .describe('Optional custom English image prompt. If omitted, uses existing image_prompt or auto-rewrites it.'),
      autoRewritePrompt: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true (and prompt is omitted), AI crafts a fresh English visual prompt from the slide heading & text before generating the image.'),
      style: z
        .enum(['dramatic', 'realistic', 'custom'])
        .optional()
        .default('dramatic')
        .describe('Visual style preset: "dramatic" (low-key chiaroscuro), "realistic" (photojournalism), or "custom".'),
      renderMedia: z
        .boolean()
        .optional()
        .default(true)
        .describe('If true, immediately re-renders the final 1080x1350 carousel PNGs via Puppeteer after generating the AI background(s).'),
    }),
    async execute(params, config) {
      return apiRequest(`/api/queue/${params.postId}/generate-slide-image`, {
        method: 'POST',
        body: JSON.stringify({
          target: params.target,
          slideIndex: params.slideIndex,
          slideIndices: params.slideIndices,
          prompt: params.prompt,
          autoRewritePrompt: params.autoRewritePrompt,
          style: params.style,
          renderMedia: params.renderMedia,
        }),
      }, config);
    },
  },

  {
    name: 'redaksi_regenerate_post',
    label: 'Redaksi.AI: Regenerate Post (Media / Copy / Full Pipeline)',
    description:
      'Run one of the 3 regeneration tiers on an existing post: "media" (0 LLM tokens, re-renders 1080x1350 PNGs from current text/images via Puppeteer), "content" (re-runs AI Writer from existing research/opinion insights + renders PNGs), or "pipeline" (fresh web research + opinion + writer + renders PNGs).',
    schema: z.object({
      postId: z.number().describe('The queue post ID.'),
      tier: z
        .enum(['media', 'content', 'pipeline'])
        .default('media')
        .describe('Regeneration tier to execute.'),
    }),
    async execute({ postId, tier }, config) {
      const endpointMap = {
        media: `/api/queue/${postId}/regenerate-media`,
        content: `/api/queue/${postId}/regenerate-content`,
        pipeline: `/api/queue/${postId}/regenerate-pipeline`,
      };
      return apiRequest(endpointMap[tier], { method: 'POST' }, config);
    },
  },

  // ============================================================================
  // DOMAIN 5: QUEUE SCHEDULER, PUBLISHING & WORKER CONTROL
  // ============================================================================
  {
    name: 'redaksi_list_queue',
    label: 'Redaksi.AI: List Posts Queue',
    description:
      'List posts in the queue filtered by connectionId and status (pending, scheduled, draft, buffering, published, error).',
    schema: z.object({
      connectionId: z.number().optional().describe('Account connection ID.'),
      status: z
        .enum(['pending', 'scheduled', 'draft', 'buffering', 'published', 'error'])
        .optional()
        .default('pending'),
    }),
    async execute({ connectionId, status = 'pending' }, config) {
      let query = `?status=${encodeURIComponent(status)}`;
      if (connectionId) query += `&connectionId=${encodeURIComponent(String(connectionId))}`;
      const items = await apiRequest<any[]>(`/api/queue${query}`, {}, config);
      const compact = items.map((item) => ({
        id: item.id,
        connectionId: item.connectionId,
        status: item.status,
        templateId: item.templateId,
        title: item.templateData?.title || item.text?.split('\n')[0]?.slice(0, 80),
        slideCount: Array.isArray(item.media) ? item.media.length : 0,
        media: item.media,
        scheduledAt: item.scheduledAt,
        publishedAt: item.publishedAt,
        postUrl: item.postUrl,
        errorLog: item.errorLog,
        sortOrder: item.sortOrder,
      }));
      return { count: compact.length, items: compact };
    },
  },

  {
    name: 'redaksi_manage_queue_item',
    label: 'Redaksi.AI: Manage Queue Item (Schedule / Reorder / Status / Delete)',
    description:
      'Schedule a post for a specific date/time, clear its schedule, move it in the queue (top/up/down or full reorder), switch status between draft and pending, duplicate it, or delete it.',
    schema: z.object({
      action: z.enum(['schedule', 'clear_schedule', 'move', 'reorder', 'set_status', 'duplicate', 'delete']),
      postId: z.number().optional().describe('Queue post ID (required for all actions except reorder).'),
      connectionId: z.number().optional().describe('Account connection ID (required for move and reorder).'),
      scheduledAt: z.string().optional().describe('ISO-8601 datetime string when action="schedule".'),
      direction: z.enum(['top', 'up', 'down']).optional().describe('Move direction when action="move".'),
      orderedIds: z.array(z.number()).optional().describe('Ordered array of pending post IDs when action="reorder".'),
      status: z.enum(['pending', 'draft']).optional().describe('Target status when action="set_status".'),
    }),
    async execute(params, config) {
      const { action, postId, connectionId, scheduledAt, direction, orderedIds, status } = params;
      if (action === 'reorder') {
        if (!connectionId || !Array.isArray(orderedIds)) {
          throw new Error('connectionId and orderedIds are required for action="reorder".');
        }
        return apiRequest('/api/queue/reorder', {
          method: 'POST',
          body: JSON.stringify({ connectionId, orderedIds }),
        }, config);
      }

      if (!postId) throw new Error(`postId is required for action="${action}".`);

      if (action === 'schedule') {
        if (!scheduledAt) throw new Error('scheduledAt ISO timestamp is required for action="schedule".');
        return apiRequest(`/api/queue/${postId}`, {
          method: 'PUT',
          body: JSON.stringify({ scheduledAt }),
        }, config);
      }
      if (action === 'clear_schedule') {
        return apiRequest(`/api/queue/${postId}`, {
          method: 'PUT',
          body: JSON.stringify({ scheduledAt: null }),
        }, config);
      }
      if (action === 'set_status') {
        if (!status) throw new Error('status ("pending" or "draft") is required for action="set_status".');
        return apiRequest(`/api/queue/${postId}`, {
          method: 'PUT',
          body: JSON.stringify({ status }),
        }, config);
      }
      if (action === 'move') {
        if (!connectionId || !direction) {
          throw new Error('connectionId and direction ("top"|"up"|"down") are required for action="move".');
        }
        return apiRequest(`/api/queue/${postId}/move`, {
          method: 'POST',
          body: JSON.stringify({ connectionId, direction }),
        }, config);
      }
      if (action === 'duplicate') {
        return apiRequest(`/api/queue/${postId}/duplicate`, { method: 'POST' }, config);
      }
      if (action === 'delete') {
        return apiRequest(`/api/queue/${postId}`, { method: 'DELETE' }, config);
      }
    },
  },

  {
    name: 'redaksi_publish_post',
    label: 'Redaksi.AI: Publish Post to Instagram / Retry Error',
    description:
      'Immediately publish a queued/draft post to Instagram via Buffer, check for upcoming 60-minute schedule conflicts, or retry a failed post.',
    schema: z.object({
      postId: z.number().describe('The queue post ID.'),
      action: z
        .enum(['publish_now', 'check_schedule_conflict', 'retry_error'])
        .default('publish_now'),
      skipUpcomingSlot: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true when publishing now, skips the next upcoming auto-slot or pushes the next scheduled post back by 1 hour.'),
    }),
    async execute({ postId, action, skipUpcomingSlot = false }, config) {
      if (action === 'check_schedule_conflict') {
        return apiRequest(`/api/queue/${postId}/upcoming-schedule`, {}, config);
      }
      if (action === 'retry_error') {
        return apiRequest(`/api/queue/${postId}/retry-error`, { method: 'POST' }, config);
      }
      const conflictCheck = await apiRequest<any>(`/api/queue/${postId}/upcoming-schedule`, {}, config).catch(
        () => ({ hasUpcoming: false })
      );
      return apiRequest(`/api/queue/${postId}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          skipUpcomingSlot,
          upcomingPostId: conflictCheck?.upcomingPostId,
        }),
      }, config);
    },
  },

  {
    name: 'redaksi_manage_worker_jobs',
    label: 'Redaksi.AI: Manage Background Worker Jobs',
    description:
      'List background AI carousel generation jobs (all or active pending/processing/recent-error), retry a failed job, or dismiss/delete a job.',
    schema: z.object({
      action: z.enum(['list_active', 'list_all', 'retry', 'dismiss']).default('list_active'),
      connectionId: z.number().optional().describe('Optional account connection ID filter.'),
      jobId: z.number().optional().describe('Job ID when action="retry" or "dismiss".'),
    }),
    async execute({ action, connectionId, jobId }, config) {
      if (action === 'list_active') {
        const q = connectionId ? `?connectionId=${connectionId}` : '';
        return apiRequest(`/api/jobs/dashboard${q}`, {}, config);
      }
      if (action === 'list_all') {
        const q = connectionId ? `?connectionId=${connectionId}` : '';
        return apiRequest(`/api/jobs${q}`, {}, config);
      }
      if (!jobId) throw new Error(`jobId is required for action="${action}".`);
      if (action === 'retry') {
        return apiRequest(`/api/jobs/${jobId}/retry`, { method: 'POST' }, config);
      }
      return apiRequest(`/api/jobs/${jobId}`, { method: 'DELETE' }, config);
    },
  },
];
