import express from 'express';
import cors from 'cors';
import { db } from './db/index.js';
import { jobsTable, queueTable, settingsTable, ideasTable, globalSettingsTable } from './db/schema.js';
import { getGlobalSettings, getConnections, getConnection } from './db/settings.js';
import { eq, asc, desc, sql } from 'drizzle-orm';
import { TEMPLATES } from './templates.js';
import { generateMedia } from './media.js';
import { publishToBuffer, fetchBufferChannelDetails } from './buffer.js';
import { runAutomatedPipeline } from './agent.js';
import { getEditorialAgentConfigs } from './agents/editorial/registry.js';
import { runResearchPhase } from './agents/editorial/research.js';
import { runOpinionPhase } from './agents/editorial/opinion.js';
import { getBaseSystemPrompt } from './utils.js';
import type { PipelineContext } from './utils.js';
import multer from 'multer';
import { uploadToS3 } from './s3.js';
import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import { generateCarouselAnalysisContent, generateCarouselAnalysisMedia } from './agents/pipelines/image/aa.geopolitik/carousel_analysis.js';
import { imageGenerator, imageEditor } from './utils/imageEditor/index.js';
import { insertQueueItem } from './db/queue.js';
import { censorText } from './sanitize.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '../public')));

const requireTriggerAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const triggerKey = process.env.TRIGGER_API_KEY;
  const authHeader = req.headers.authorization;
  if (!triggerKey || authHeader !== `Bearer ${triggerKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

const requireDashboardAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const dashboardPassword = process.env.DASHBOARD_PASSWORD;
  const authHeader = req.headers.authorization;
  if (!dashboardPassword || authHeader !== `Bearer ${dashboardPassword}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.post('/api/trigger-publish', requireTriggerAuth, async (req, res) => {
  try {
    const pendingPosts = await db.select()
      .from(queueTable)
      .where(eq(queueTable.status, 'pending'))
      .orderBy(asc(queueTable.sortOrder))
      .limit(1);

    if (pendingPosts.length === 0) {
      return res.status(200).json({ message: 'No pending posts to publish.' });
    }

    const post = pendingPosts[0];
    if (!post.connectionId) {
      return res.status(400).json({ error: 'Post missing connectionId' });
    }

    console.log(`[API] Triggering publish for post ID ${post.id}`);

    try {
      const connection = await getConnection(post.connectionId);
      if (!connection) throw new Error('Connection not found for post.');

      let mediaToPublish = [...post.media];
      const ctaUrl = connection.ctaImageUrl;
      if (ctaUrl && !mediaToPublish.some(m => m.url === ctaUrl)) {
        mediaToPublish.push({ type: 'image', url: ctaUrl });
      }

      const result = await publishToBuffer(mediaToPublish, post.text, post.publishMetadata, post.connectionId);
      
      await db.update(queueTable)
        .set({ 
          status: 'buffering', 
          bufferPostId: result?.id || null 
        })
        .where(eq(queueTable.id, post.id));

      console.log(`[API] Successfully submitted post ID ${post.id} to Buffer (bufferPostId: ${result?.id}). Status: buffering`);
      return res.status(200).json({ message: 'Submitted to Buffer successfully', postId: post.id, bufferResult: result });
    } catch (publishError: any) {
      console.error(`[API] Failed to publish post ID ${post.id}:`, publishError);
      await db.update(queueTable)
        .set({ status: 'error', errorLog: publishError.message || String(publishError) })
        .where(eq(queueTable.id, post.id));

      return res.status(500).json({ error: 'Failed to publish to Buffer', details: publishError.message });
    }
  } catch (error: any) {
    console.error('[API] Error in trigger-publish endpoint:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/upload', requireDashboardAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const buffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
      return res.status(400).json({ error: 'Only image and video files are allowed' });
    }

    let ext = '.jpg';
    if (mimeType === 'image/png') ext = '.png';
    else if (mimeType === 'image/webp') ext = '.webp';
    else if (mimeType === 'video/mp4') ext = '.mp4';
    else if (mimeType === 'video/quicktime') ext = '.mov';
    else if (mimeType === 'video/webm') ext = '.webm';
    
    const s3Url = await uploadToS3(buffer, mimeType, ext);
    if (!s3Url) throw new Error('Failed to upload to S3');

    res.json({ url: s3Url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate-content', requireDashboardAuth, async (req, res) => {
  try {
    const { text, mediaUrl, mediaUrls, templateId, connectionId } = req.body;
    if (!text) return res.status(400).json({ error: 'Text input is required' });
    if (!connectionId) return res.status(400).json({ error: 'connectionId is required' });

    let media: { type: 'image' | 'video', url: string }[] = [];
    if (mediaUrls && Array.isArray(mediaUrls)) {
      media = mediaUrls.map((url: string) => ({ 
        type: url.match(/\.(mp4|mov|webm)$/i) ? 'video' : 'image', 
        url 
      }));
    } else if (mediaUrl) {
      media = [{ type: 'image' as const, url: mediaUrl }];
    }

    const result = await db.insert(jobsTable).values({
      connectionId: parseInt(connectionId),
      chatId: 'DASHBOARD',
      messageId: Date.now(),
      templateId: templateId || 'image:poros.perjuangan:carousel_dark',
      text,
      media,
      status: 'pending'
    }).returning();

    res.json({ message: 'Job enqueued successfully', job: result[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/from-script', requireDashboardAuth, async (req, res) => {
  try {
    const {
      text,
      connectionId,
      templateId = 'image:aa.geopolitik:carousel_analysis',
      generateImages = false,
      status = 'draft'
    } = req.body;

    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'Script text is required' });
    }
    if (!connectionId) {
      return res.status(400).json({ error: 'connectionId is required' });
    }

    const connId = parseInt(String(connectionId), 10);
    const connection = await getConnection(connId);
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    const currentDateObj = new Date();
    const currentYear = currentDateObj.getFullYear();
    const currentDateStr = currentDateObj.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Jakarta'
    });
    const baseSystemPrompt = getBaseSystemPrompt(currentDateStr, currentYear);
    const bannedWords = (connection as any).bannedWords || [];

    const context: PipelineContext = {
      chatId: 'DASHBOARD_SCRIPT',
      messageId: Date.now(),
      userInput: String(text),
      uploadedMedia: [],
      telegram: null,
      statusMsg: null,
      settings: connection as any,
      currentDateStr,
      currentYear,
      baseSystemPrompt,
      connectionId: connId,
    };

    const contentParams = await generateCarouselAnalysisContent(context, {});

    let coverImageUrl = '';
    const slideImages: string[] = [];

    if (generateImages) {
      try {
        const coverRes = await imageEditor({
          mode: 'Dark-Dramatize',
          image: null,
          searchQuery: contentParams.title,
          prompt: contentParams.image_prompt,
          uploadToS3: true,
        });
        if (coverRes?.url) coverImageUrl = coverRes.url;
      } catch (err) {
        console.warn('[from-script] Cover image generation failed:', err);
      }

      for (let i = 0; i < contentParams.slides.length; i++) {
        const slide = contentParams.slides[i];
        const prompt = slide.image_prompt || `${slide.title} dark geopolitical photography`;
        try {
          const slideRes = await imageGenerator({
            prompt,
            style: 'dramatic',
            aspectRatio: '4:5',
            uploadToS3: true,
          });
          slideImages.push(slideRes?.url || coverImageUrl);
        } catch (err) {
          console.warn(`[from-script] Slide ${i + 1} image generation failed:`, err);
          slideImages.push(coverImageUrl);
        }
      }
    }

    const slidesWithImages = contentParams.slides.map((s, idx) => ({
      ...s,
      text: censorText(s.text, bannedWords),
      slide_image: slideImages[idx] || coverImageUrl || ''
    }));

    const templateData: Record<string, any> = {
      title: censorText(contentParams.title, bannedWords),
      subtitle: censorText(contentParams.subtitle, bannedWords),
      image_prompt: contentParams.image_prompt,
      slides: slidesWithImages,
      source_name: contentParams.source_name,
      source_url: contentParams.source_url,
      coverImageUrl,
      inputImages: []
    };

    let renderedMedia: { type: 'image' | 'video'; url: string }[] = [];
    if (generateImages) {
      try {
        renderedMedia = await generateCarouselAnalysisMedia(templateData, connection);
      } catch (renderErr) {
        console.warn('[from-script] Media renderer not reachable or failed, saving draft without rendered PNGs:', renderErr);
      }
    }

    const [inserted] = await insertQueueItem({
      connectionId: connId,
      templateId,
      templateData,
      text: contentParams.finalCaption,
      media: renderedMedia,
      status: status === 'pending' ? 'pending' : 'draft',
      chatId: 'DASHBOARD_SCRIPT',
      messageId: Date.now(),
      researchResult: '',
      agentInsights: {},
      rawInput: String(text)
    });

    return res.json({
      message: 'Carousel created from script successfully',
      item: inserted,
      slideCount: slidesWithImages.length
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

app.get('/api/templates', requireDashboardAuth, (req, res) => {
  const templatesList = Object.values(TEMPLATES).map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    uiSchema: t.uiSchema
  }));
  res.json(templatesList);
});

app.get('/api/ideas', requireDashboardAuth, async (req, res) => {
  try {
    const status = req.query.status as string;
    const connectionId = req.query.connectionId ? parseInt(req.query.connectionId as string) : undefined;
    
    let query = db.select().from(ideasTable);
    const conditions = [];
    if (status) conditions.push(eq(ideasTable.status, status));
    if (connectionId) conditions.push(eq(ideasTable.connectionId, connectionId));
    
    const allIdeas = await db.select()
      .from(ideasTable)
      .where(conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined)
      .orderBy(desc(ideasTable.createdAt))
      .limit(100);
      
    res.json(allIdeas);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ideas/:id/convert', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const [idea] = await db.select().from(ideasTable).where(eq(ideasTable.id, id));
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    
    if (idea.status === 'converted') {
      return res.status(400).json({ error: 'Idea already converted' });
    }

    const { templateId } = req.body;
    let chosenTemplateId = templateId;
    if (!chosenTemplateId) {
      const media = idea.media || [];
      const isSingleVideo = media.length === 1 && media[0]?.type === 'video';
      chosenTemplateId = isSingleVideo ? 'video:poros.perjuangan:title_only' : 'image:poros.perjuangan:carousel_dark';
    }

    await db.insert(jobsTable).values({
      connectionId: idea.connectionId,
      chatId: idea.chatId,
      messageId: idea.messageId,
      text: idea.text,
      media: idea.media,
      templateId: chosenTemplateId,
      status: 'pending'
    });

    await db.update(ideasTable).set({ status: 'converted' }).where(eq(ideasTable.id, id));
    
    res.json({ message: 'Idea converted to job successfully' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

app.put('/api/ideas/:id/status', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const { status } = req.body;
    
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!status || !['pending', 'converted', 'rejected'].includes(status)) {
       return res.status(400).json({ error: 'Invalid status' });
    }

    await db.update(ideasTable).set({ status }).where(eq(ideasTable.id, id));
    res.json({ message: 'Status updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/jobs', requireDashboardAuth, async (req, res) => {
  try {
    const connectionId = req.query.connectionId ? parseInt(req.query.connectionId as string) : undefined;
    const allJobs = await db.select()
      .from(jobsTable)
      .where(connectionId ? eq(jobsTable.connectionId, connectionId) : undefined)
      .orderBy(desc(jobsTable.createdAt))
      .limit(100);
    res.json(allJobs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/retry', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid job ID' });

    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id));
    
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'error') return res.status(400).json({ error: 'Job is not in an error state' });

    await db.update(jobsTable)
      .set({ status: 'pending', errorLog: null, updatedAt: new Date() })
      .where(eq(jobsTable.id, id));
      
    res.json({ success: true, message: 'Job queued for retry' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retry job: ' + error.message });
  }
});

app.get('/api/jobs/dashboard', requireDashboardAuth, async (req, res) => {
  try {
    const connectionId = req.query.connectionId ? parseInt(req.query.connectionId as string) : undefined;
    const activeJobs = await db.select()
      .from(jobsTable)
      .where(
        connectionId 
          ? sql`chat_id = 'DASHBOARD' AND status IN ('pending', 'processing', 'error') AND connection_id = ${connectionId}`
          : sql`chat_id = 'DASHBOARD' AND status IN ('pending', 'processing', 'error')`
      )
      .orderBy(desc(jobsTable.createdAt));
    res.json(activeJobs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

import { generateText } from 'ai';

app.post('/api/ai/refine-text', requireDashboardAuth, async (req, res) => {
  try {
    const { text, instruction, context } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });
    if (!process.env.LIGHT_MODEL) return res.status(500).json({ error: 'LIGHT_MODEL is not configured' });

    let prompt = `You are a helpful AI editor. I will provide you with some original text. Your job is to strictly improve and refine the text based on the provided instructions. Output ONLY the finalized refined text. Do not add any conversational filler like "Here is the refined text:". If no specific instruction is provided, just improve the grammar, spelling, and general flow while maintaining the original meaning and tone.\n\n`;
    if (context && context.trim()) prompt += `CONTEXT ABOUT THIS TEXT:\n${context}\n\n`;
    if (instruction && instruction.trim()) prompt += `USER INSTRUCTIONS:\n${instruction}\n\n`;
    prompt += `ORIGINAL TEXT:\n${text}`;

    const { text: refinedText } = await generateText({
      model: google(process.env.LIGHT_MODEL),
      prompt: prompt
    });
    res.json({ refinedText });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/connections/:id/slots/generate', requireDashboardAuth, async (req, res) => {
  try {
    const { prompt } = req.body;
    const connectionId = parseInt(req.params.id as string, 10);
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
    if (!process.env.LIGHT_MODEL) return res.status(500).json({ error: 'LIGHT_MODEL is not configured' });

    const connection = await getConnection(connectionId);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    
    const currentSlots = connection.postingSlots || [];

    const result = await generateObject({
      model: google(process.env.LIGHT_MODEL),
      system: 'You are an intelligent assistant that manages posting schedules. You will be given the CURRENT posting slots and a user PROMPT. Based on the prompt, you must return the FINAL complete list of posting slots. You can add new slots, remove specific ones, or completely overwrite them depending on what the user asks. Valid days: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday. Times MUST be in 24-hour HH:mm format (e.g. 08:12, 19:30). "Everyday" means all 7 days.',
      prompt: `CURRENT SLOTS:\n${JSON.stringify(currentSlots, null, 2)}\n\nUSER PROMPT: "${prompt}"\n\nPlease output the final complete list of slots after applying the user's request.`,
      schema: z.object({
        slots: z.array(z.object({
          day: z.string().describe('Day of the week (e.g., Monday)'),
          time: z.string().describe('24-hour time string in HH:mm format (e.g. "08:12" or "19:30")')
        }))
      })
    });

    const finalSlots = result.object.slots;

    await db.update(settingsTable)
      .set({ postingSlots: finalSlots })
      .where(eq(settingsTable.id, connectionId));

    res.json({ message: 'Slots generated successfully', slots: finalSlots });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GLOBAL SETTINGS
app.get('/api/global-settings', requireDashboardAuth, async (req, res) => {
  try {
    const globalSettings = await getGlobalSettings();
    res.json(globalSettings);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/global-settings', requireDashboardAuth, async (req, res) => {
  try {
    const { telegramBotToken } = req.body;
    await db.update(globalSettingsTable).set({ telegramBotToken }).where(eq(globalSettingsTable.id, 1));
    res.json({ message: 'Global settings updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// CONNECTIONS
app.get('/api/connections', requireDashboardAuth, async (req, res) => {
  try {
    const connections = await getConnections();
    res.json(connections);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/connections/test-buffer', requireDashboardAuth, async (req, res) => {
  try {
    const { bufferApiKey, bufferChannelId } = req.body;
    if (!bufferApiKey || !bufferChannelId) {
      return res.status(400).json({ error: 'Buffer API Key and Channel ID are required.' });
    }

    const details = await fetchBufferChannelDetails(String(bufferApiKey).trim(), String(bufferChannelId).trim());
    res.json({
      success: true,
      name: details.name,
      network: details.network
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to connect to Buffer'
    });
  }
});


app.post('/api/connections', requireDashboardAuth, async (req, res) => {
  try {
    const { name, bufferApiKey, bufferChannelId } = req.body;
    
    let bufferChannelNetwork = 'instagram';
    let connectionName = name || 'New Connection';

    if (bufferApiKey && bufferChannelId) {
      try {
        const details = await fetchBufferChannelDetails(bufferApiKey, bufferChannelId);
        bufferChannelNetwork = details.network;
        if (!name) connectionName = details.name;
      } catch (err: any) {
        console.error("Failed to fetch Buffer channel details:", err);
      }
    }

    const [inserted] = await db.insert(settingsTable).values({
      name: connectionName,
      bufferApiKey,
      bufferChannelId,
      bufferChannelNetwork
    }).returning();

    res.json({ message: 'Connection created', connection: inserted });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/connections/:id', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const connection = await getConnection(id);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const updateData: any = {};
    if (req.body.name !== undefined) updateData.name = req.body.name;
    if (req.body.logoImageUrl !== undefined) updateData.logoImageUrl = req.body.logoImageUrl;
    if (req.body.ctaImageUrl !== undefined) updateData.ctaImageUrl = req.body.ctaImageUrl;
    if (req.body.bufferApiKey !== undefined) updateData.bufferApiKey = req.body.bufferApiKey;
    if (req.body.bufferChannelId !== undefined) updateData.bufferChannelId = req.body.bufferChannelId;
    if (req.body.editorialGuidelines !== undefined) updateData.editorialGuidelines = req.body.editorialGuidelines;
    if (req.body.cronIntervalMinutes !== undefined) updateData.cronIntervalMinutes = parseInt(req.body.cronIntervalMinutes, 10);
    if (req.body.cronStartHour !== undefined) updateData.cronStartHour = parseInt(req.body.cronStartHour, 10);
    if (req.body.cronEndHour !== undefined) updateData.cronEndHour = parseInt(req.body.cronEndHour, 10);
    if (req.body.postingSlots !== undefined) updateData.postingSlots = req.body.postingSlots;
    if (req.body.bannedWords !== undefined) updateData.bannedWords = req.body.bannedWords;

    if (
      (req.body.bufferApiKey !== undefined || req.body.bufferChannelId !== undefined) &&
      (updateData.bufferApiKey || connection.bufferApiKey) &&
      (updateData.bufferChannelId || connection.bufferChannelId)
    ) {
      try {
        const apiKey = updateData.bufferApiKey || connection.bufferApiKey;
        const channelId = updateData.bufferChannelId || connection.bufferChannelId;
        const details = await fetchBufferChannelDetails(apiKey, channelId);
        updateData.bufferChannelNetwork = details.network;
        if (!req.body.name && updateData.name === undefined) {
          updateData.name = details.name;
        }
      } catch (err: any) {
        console.error("Failed to fetch Buffer channel network:", err);
      }
    }
    
    await db.update(settingsTable).set(updateData).where(eq(settingsTable.id, id));
    res.json({ message: 'Connection updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/connections/:id', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid connection ID' });

    // Delete related child records first to satisfy foreign key constraints
    await db.delete(queueTable).where(eq(queueTable.connectionId, id));
    await db.delete(ideasTable).where(eq(ideasTable.connectionId, id));
    await db.delete(jobsTable).where(eq(jobsTable.connectionId, id));

    await db.delete(settingsTable).where(eq(settingsTable.id, id));
    res.json({ message: 'Connection and all associated data deleted successfully' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

app.post('/api/queue', requireDashboardAuth, async (req, res) => {
  try {
    const { connectionId, text, media, type, scheduledAt } = req.body;
    if (!connectionId) return res.status(400).json({ error: 'connectionId is required' });
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (!media || !Array.isArray(media) || media.length === 0) return res.status(400).json({ error: 'media array is required' });
    if (type !== 'post' && type !== 'reel') return res.status(400).json({ error: 'type must be post or reel' });

    const connection = await db.select().from(settingsTable).where(eq(settingsTable.id, connectionId));
    if (connection.length === 0) return res.status(404).json({ error: 'Connection not found' });
    
    const channelNetwork = connection[0].bufferChannelNetwork || 'instagram';

    const maxSortResult = await db.select({ maxSort: sql`MAX(sort_order)` })
      .from(queueTable)
      .where(sql`connection_id = ${connectionId} AND status = 'pending'`);
    const maxSort = (maxSortResult[0]?.maxSort as number) || 0;
    const newSortOrder = maxSort + 10;

    const publishMetadata = {
      [channelNetwork]: {
        type: type === 'reel' ? 'reel' : 'post',
        shouldShareToFeed: true
      }
    };

    const result = await db.insert(queueTable).values({
      connectionId,
      text,
      media,
      templateId: 'manual',
      status: 'pending',
      sortOrder: newSortOrder,
      publishMetadata,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null
    }).returning();

    res.json({ message: 'Added to queue successfully', item: result[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/batch', requireDashboardAuth, async (req, res) => {
  try {
    const { connectionId, items } = req.body;
    if (!connectionId) return res.status(400).json({ error: 'connectionId is required' });
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const connection = await db.select().from(settingsTable).where(eq(settingsTable.id, connectionId));
    if (connection.length === 0) return res.status(404).json({ error: 'Connection not found' });
    
    const channelNetwork = connection[0].bufferChannelNetwork || 'instagram';

    const maxSortResult = await db.select({ maxSort: sql`MAX(sort_order)` })
      .from(queueTable)
      .where(sql`connection_id = ${connectionId} AND status = 'pending'`);
    let currentSortOrder = (maxSortResult[0]?.maxSort as number) || 0;

    const valuesToInsert = items.map(item => {
      currentSortOrder += 10;
      
      const publishMetadata = {
        [channelNetwork]: {
          type: item.type === 'reel' ? 'reel' : 'post',
          shouldShareToFeed: true
        }
      };

      return {
        connectionId,
        text: item.text,
        media: item.media,
        templateId: 'manual',
        status: 'pending',
        sortOrder: currentSortOrder,
        publishMetadata,
        scheduledAt: item.scheduledAt ? new Date(item.scheduledAt) : null
      };
    });

    const result = await db.insert(queueTable).values(valuesToInsert).returning();

    res.json({ message: `Added ${result.length} items to queue successfully`, items: result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/queue', requireDashboardAuth, async (req, res) => {
  try {
    const status = req.query.status as string || 'pending';
    const connectionId = req.query.connectionId ? parseInt(req.query.connectionId as string) : undefined;
    
    const conditions = [];
    if (connectionId) conditions.push(eq(queueTable.connectionId, connectionId));
    
    let items;
    if (status === 'pending') {
      conditions.push(eq(queueTable.status, 'pending'));
      conditions.push(sql`scheduled_at IS NULL`);
      items = await db.select().from(queueTable)
        .where(sql`${sql.join(conditions, sql` AND `)}`)
        .orderBy(asc(queueTable.sortOrder));
    } else if (status === 'scheduled') {
      conditions.push(eq(queueTable.status, 'pending'));
      conditions.push(sql`scheduled_at IS NOT NULL`);
      items = await db.select().from(queueTable)
        .where(sql`${sql.join(conditions, sql` AND `)}`)
        .orderBy(asc(queueTable.scheduledAt));
    } else {
      conditions.push(eq(queueTable.status, status));
      items = await db.select().from(queueTable)
        .where(sql`${sql.join(conditions, sql` AND `)}`)
        .orderBy(desc(queueTable.createdAt));
    }
    
    res.json(items);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/queue/:id', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const items = await db.select().from(queueTable).where(eq(queueTable.id, id));
    if (items.length === 0) return res.status(404).json({ error: 'Post not found' });

    res.json(items[0]);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
app.put('/api/queue/:id', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const { text, templateData, scheduledAt, status, agentInsights } = req.body;
    
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const updateData: any = {};
    if (text !== undefined) updateData.text = text;
    if (templateData !== undefined) updateData.templateData = templateData;
    if (scheduledAt !== undefined) {
      updateData.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
    }
    if (status !== undefined) {
      if (!['pending', 'draft', 'published', 'error', 'processing'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updateData.status = status;
    }
    if (agentInsights !== undefined) {
      updateData.agentInsights = agentInsights;
    }
    if (Object.keys(updateData).length > 0) {
      await db.update(queueTable)
        .set(updateData)
        .where(eq(queueTable.id, id));
    }

    res.json({ message: 'Updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:id/regenerate-media', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const items = await db.select().from(queueTable).where(eq(queueTable.id, id));
    if (items.length === 0) return res.status(404).json({ error: 'Post not found in queue' });
    
    const post = items[0];
    if (!post.connectionId) return res.status(400).json({ error: 'Post missing connectionId' });
    
    const template = TEMPLATES[post.templateId];
    if (!template) return res.status(400).json({ error: `Template ${post.templateId} not found` });

    try {
      const connection = await getConnection(post.connectionId);
      if (!connection) throw new Error('Connection not found');
      
      const allPublishUrls = await template.regenerateMedia(post.templateData, connection as any);

      await db.update(queueTable)
        .set({ media: allPublishUrls })
        .where(eq(queueTable.id, post.id));

      return res.json({ message: 'Media regenerated successfully', media: allPublishUrls });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to regenerate media', details: err.message });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:id/generate-slide-image', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const { target = 'slide', slideIndex, prompt, renderMedia = false } = req.body;
    const items = await db.select().from(queueTable).where(eq(queueTable.id, id));
    if (items.length === 0) return res.status(404).json({ error: 'Post not found in queue' });

    const post = items[0];
    const templateData: Record<string, any> = { ...(post.templateData as Record<string, any> || {}) };
    let generatedUrl = '';

    if (target === 'cover') {
      const coverPrompt = prompt || templateData.image_prompt || templateData.title || 'dark geopolitical editorial background';
      templateData.image_prompt = coverPrompt;
      const coverRes = await imageGenerator({
        prompt: coverPrompt,
        style: 'dramatic',
        aspectRatio: '4:5',
        uploadToS3: true,
      });
      generatedUrl = coverRes.url || '';
      templateData.coverImageUrl = generatedUrl;
    } else if (target === 'all') {
      const coverPrompt = templateData.image_prompt || templateData.title || 'dark geopolitical editorial background';
      const coverRes = await imageGenerator({
        prompt: coverPrompt,
        style: 'dramatic',
        aspectRatio: '4:5',
        uploadToS3: true,
      });
      if (coverRes.url) {
        templateData.coverImageUrl = coverRes.url;
      }
      if (Array.isArray(templateData.slides)) {
        for (let i = 0; i < templateData.slides.length; i++) {
          const slide = templateData.slides[i];
          const sPrompt = slide.image_prompt || slide.title || 'dark geopolitical editorial photography';
          const sRes = await imageGenerator({
            prompt: sPrompt,
            style: 'dramatic',
            aspectRatio: '4:5',
            uploadToS3: true,
          });
          if (sRes.url) {
            templateData.slides[i].slide_image = sRes.url;
          }
        }
      }
    } else {
      const idx = Number(slideIndex);
      if (!Array.isArray(templateData.slides) || isNaN(idx) || idx < 0 || idx >= templateData.slides.length) {
        return res.status(400).json({ error: 'Valid slideIndex is required' });
      }
      const slide = templateData.slides[idx];
      const slidePrompt = prompt || slide.image_prompt || slide.title || 'dark geopolitical editorial photography';
      templateData.slides[idx].image_prompt = slidePrompt;

      const slideRes = await imageGenerator({
        prompt: slidePrompt,
        style: 'dramatic',
        aspectRatio: '4:5',
        uploadToS3: true,
      });
      generatedUrl = slideRes.url || '';
      templateData.slides[idx].slide_image = generatedUrl;
    }

    let media = post.media;
    if (renderMedia && post.connectionId) {
      const template = TEMPLATES[post.templateId];
      const connection = await getConnection(post.connectionId);
      if (template && connection) {
        try {
          media = await template.regenerateMedia(templateData, connection as any);
        } catch (renderErr) {
          console.warn('[generate-slide-image] Optional media render failed:', renderErr);
        }
      }
    }

    await db.update(queueTable)
      .set({ templateData, media })
      .where(eq(queueTable.id, post.id));

    return res.json({
      message: 'Image generated successfully',
      url: generatedUrl,
      templateData,
      media
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

app.get('/api/editorial/agents', requireDashboardAuth, (_req, res) => {
  try {
    const configs = getEditorialAgentConfigs();
    res.json(configs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:id/regenerate-content', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const items = await db.select().from(queueTable).where(eq(queueTable.id, id));
    if (items.length === 0) return res.status(404).json({ error: 'Post not found in queue' });
    
    const post = items[0];
    if (!post.connectionId) return res.status(400).json({ error: 'Post missing connectionId' });
    
    const template = TEMPLATES[post.templateId];
    if (!template) return res.status(400).json({ error: `Template ${post.templateId} not found` });

    const connection = await getConnection(post.connectionId);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const insights = post.agentInsights || (post.researchResult ? { research: post.researchResult } : {});
    
    const currentDateObj = new Date();
    const currentYear = currentDateObj.getFullYear();
    const currentDateStr = currentDateObj.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
    const baseSystemPrompt = getBaseSystemPrompt(currentDateStr, currentYear);

    const context: PipelineContext = {
      chatId: post.chatId || '',
      messageId: post.messageId || 0,
      userInput: post.rawInput || post.text,
      uploadedMedia: [],
      telegram: null,
      statusMsg: null,
      settings: connection,
      currentDateStr,
      currentYear,
      baseSystemPrompt,
      connectionId: post.connectionId,
      agentInsights: insights,
    };

    let newText = post.text;
    let newTemplateData = post.templateData;

    if (template.regenerateContent) {
      const regenerated = await template.regenerateContent(post.templateData, connection, insights, context);
      newText = regenerated.text;
      newTemplateData = regenerated.templateData;
    }

    const allPublishUrls = await template.regenerateMedia(newTemplateData, connection as any);

    await db.update(queueTable)
      .set({
        text: newText,
        templateData: newTemplateData,
        media: allPublishUrls,
      })
      .where(eq(queueTable.id, post.id));

    return res.json({
      message: 'Content and media regenerated successfully',
      text: newText,
      templateData: newTemplateData,
      media: allPublishUrls,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:id/regenerate-pipeline', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const items = await db.select().from(queueTable).where(eq(queueTable.id, id));
    if (items.length === 0) return res.status(404).json({ error: 'Post not found in queue' });
    
    const post = items[0];
    if (!post.connectionId) return res.status(400).json({ error: 'Post missing connectionId' });
    
    const template = TEMPLATES[post.templateId];
    if (!template) return res.status(400).json({ error: `Template ${post.templateId} not found` });

    const connection = await getConnection(post.connectionId);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const currentDateObj = new Date();
    const currentYear = currentDateObj.getFullYear();
    const currentDateStr = currentDateObj.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
    const baseSystemPrompt = getBaseSystemPrompt(currentDateStr, currentYear);

    const rawInput = post.rawInput || post.text;

    const pipelineContext: PipelineContext = {
      chatId: post.chatId || '',
      messageId: post.messageId || 0,
      userInput: rawInput,
      uploadedMedia: [],
      telegram: null,
      statusMsg: null,
      settings: connection,
      currentDateStr,
      currentYear,
      baseSystemPrompt,
      connectionId: post.connectionId,
    };

    // 1. Run Research
    const researchResult = await runResearchPhase(pipelineContext);
    const agentInsights: Record<string, string> = {};
    if (researchResult.researchText) {
      agentInsights.research = researchResult.researchText;
    }

    // 2. Run Opinion (if required)
    const requiresOpinion = template.requiredEditorialAgents?.includes('opinion') ||
      Boolean(template.slidesComposition?.opinion && template.slidesComposition.opinion > 0);

    if (requiresOpinion && researchResult.researchText) {
      const opinionText = await runOpinionPhase(pipelineContext, researchResult.researchText);
      if (opinionText) {
        agentInsights.opinion = opinionText;
      }
    }

    pipelineContext.agentInsights = agentInsights;

    // 3. Re-generate content & media
    let newText = post.text;
    let newTemplateData = post.templateData;

    if (template.regenerateContent) {
      const regenerated = await template.regenerateContent(post.templateData, connection, agentInsights, pipelineContext);
      newText = regenerated.text;
      newTemplateData = regenerated.templateData;
    }

    const allPublishUrls = await template.regenerateMedia(newTemplateData, connection as any);

    await db.update(queueTable)
      .set({
        text: newText,
        templateData: newTemplateData,
        media: allPublishUrls,
        researchResult: researchResult.researchText,
        agentInsights: agentInsights,
        rawInput: rawInput,
      })
      .where(eq(queueTable.id, post.id));

    return res.json({
      message: 'Whole pipeline regenerated successfully',
      text: newText,
      templateData: newTemplateData,
      media: allPublishUrls,
      researchResult: researchResult.researchText,
      agentInsights: agentInsights,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/queue/:id/upcoming-schedule', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const scheduleInfo = await checkUpcomingSchedule({ db, postId: id });
    return res.json(scheduleInfo);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:id/publish', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const items = await db.select().from(queueTable).where(eq(queueTable.id, id));
    if (items.length === 0) return res.status(404).json({ error: 'Post not found in queue' });
    
    const post = items[0];
    if (!post.connectionId) return res.status(400).json({ error: 'Post missing connectionId' });
    
    try {
      const connection = await getConnection(post.connectionId);
      if (!connection) throw new Error('Connection not found');
      
      let mediaToPublish = [...post.media];
      const ctaUrl = connection.ctaImageUrl;
      if (ctaUrl && !mediaToPublish.some(m => m.url === ctaUrl)) {
        mediaToPublish.push({ type: 'image', url: ctaUrl });
      }

      const result = await publishToBuffer(mediaToPublish, post.text, post.publishMetadata, post.connectionId);
      
      await db.update(queueTable)
        .set({
          status: 'buffering',
          bufferPostId: result?.id || null,
          publishedAt: new Date(),
        })
        .where(eq(queueTable.id, id));

      // Handle skipping upcoming slot/post if requested by user
      const { skipUpcomingSlot, upcomingPostId } = req.body || {};
      if (skipUpcomingSlot) {
        if (upcomingPostId) {
          const [upPost] = await db.select().from(queueTable).where(eq(queueTable.id, upcomingPostId));
          if (upPost && upPost.scheduledAt) {
            // Push upcoming custom scheduled post back by 1 hour
            const newScheduledAt = new Date(new Date(upPost.scheduledAt).getTime() + 60 * 60 * 1000);
            await db.update(queueTable)
              .set({ scheduledAt: newScheduledAt })
              .where(eq(queueTable.id, upPost.id));
            console.log(`[API] Pushed upcoming scheduled post ID ${upPost.id} back by 1 hour to ${newScheduledAt.toISOString()}`);
          }
        }
        // Update lastAutoPublishAt to skip upcoming auto slot
        await db.update(settingsTable)
          .set({ lastAutoPublishAt: new Date() })
          .where(eq(settingsTable.id, post.connectionId));
        console.log(`[API] Set lastAutoPublishAt for connection ${post.connectionId} to skip upcoming auto slot.`);
      }
        
      res.json({ message: 'Submitted to Buffer successfully', result });
    } catch (publishError: any) {
      await db.update(queueTable)
        .set({
          status: 'error',
          errorLog: publishError.message || String(publishError)
        })
        .where(eq(queueTable.id, post.id));

      return res.status(500).json({ error: 'Failed to publish to Buffer', details: publishError.message });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:id/retry-error', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const items = await db.select().from(queueTable).where(eq(queueTable.id, id));
    if (items.length === 0) return res.status(404).json({ error: 'Post not found' });
    
    if (items[0].status !== 'error') {
      return res.status(400).json({ error: 'Only failed posts can be retried' });
    }

    await db.update(queueTable)
      .set({ 
        status: 'pending', 
        errorLog: null,
        retryCount: 0,
        nextRetryAt: null
      })
      .where(eq(queueTable.id, id));

    res.json({ message: 'Post moved back to pending queue successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/reorder', requireDashboardAuth, async (req, res) => {
  try {
    const { orderedIds, connectionId } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds array required' });
    if (!connectionId) return res.status(400).json({ error: 'connectionId is required' });

    const pending = await db.select().from(queueTable)
      .where(sql`status = 'pending' AND connection_id = ${connectionId}`)
      .orderBy(asc(queueTable.sortOrder));

    const pendingIds = new Set(pending.map(p => p.id));
    
    let sortOrder = 10;
    const updates = [];
    for (const id of orderedIds) {
      if (pendingIds.has(id)) {
        updates.push(
          db.update(queueTable).set({ sortOrder }).where(eq(queueTable.id, id))
        );
        sortOrder += 10;
      }
    }
    await Promise.all(updates);

    res.json({ message: 'Reordered successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:id/move', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const { direction, connectionId } = req.body;
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!connectionId) return res.status(400).json({ error: 'connectionId is required' });

    const pending = await db.select().from(queueTable)
      .where(sql`status = 'pending' AND connection_id = ${connectionId}`)
      .orderBy(asc(queueTable.sortOrder));
      
    const index = pending.findIndex(p => p.id === id);
    if (index === -1) return res.status(404).json({ error: 'Post not found in pending queue' });

    if (direction === 'top' && index > 0) {
      const firstItem = pending[0];
      const newSortOrder = firstItem.sortOrder - 1;
      await db.update(queueTable).set({ sortOrder: newSortOrder }).where(eq(queueTable.id, id));
    } else if (direction === 'up' && index > 0) {
      const prevItem = pending[index - 1];
      const currentItem = pending[index];
      await db.update(queueTable).set({ sortOrder: prevItem.sortOrder }).where(eq(queueTable.id, currentItem.id));
      await db.update(queueTable).set({ sortOrder: currentItem.sortOrder }).where(eq(queueTable.id, prevItem.id));
    } else if (direction === 'down' && index < pending.length - 1) {
      const nextItem = pending[index + 1];
      const currentItem = pending[index];
      await db.update(queueTable).set({ sortOrder: nextItem.sortOrder }).where(eq(queueTable.id, currentItem.id));
      await db.update(queueTable).set({ sortOrder: currentItem.sortOrder }).where(eq(queueTable.id, nextItem.id));
    }

    res.json({ message: 'Moved successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:id/duplicate', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const rows = await db.select().from(queueTable).where(eq(queueTable.id, id));
    if (rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    
    const originalItem = rows[0];
    const connectionId = originalItem.connectionId;

    const maxSortResult = await db.select({ maxSort: sql`MAX(sort_order)` })
      .from(queueTable)
      .where(sql`connection_id = ${connectionId} AND status = 'pending'`);
    const maxSort = (maxSortResult[0]?.maxSort as number) || 0;
    const newSortOrder = maxSort + 10;

    const result = await db.insert(queueTable).values({
      connectionId: originalItem.connectionId,
      text: originalItem.text,
      media: originalItem.media,
      templateId: originalItem.templateId,
      templateData: originalItem.templateData,
      publishMetadata: originalItem.publishMetadata,
      researchResult: originalItem.researchResult,
      agentInsights: originalItem.agentInsights || (originalItem.researchResult ? { research: originalItem.researchResult } : {}),
      rawInput: originalItem.rawInput,
      status: 'pending',
      sortOrder: newSortOrder,
      scheduledAt: null,
      publishedAt: null,
      errorLog: null
    }).returning();

    res.json({ message: 'Post duplicated to queue successfully', item: result[0] });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: errorMessage });
  }
});

app.delete('/api/queue/:id', requireDashboardAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    await db.delete(queueTable).where(eq(queueTable.id, id));
    res.json({ message: 'Deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get(['/', '/*path'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

export const startServer = (port: number = 3000) => {
  if (!process.env.TRIGGER_API_KEY) console.warn('WARNING: TRIGGER_API_KEY is not set in env.');
  if (!process.env.DASHBOARD_PASSWORD) console.warn('WARNING: DASHBOARD_PASSWORD is not set in env. Dashboard will be inaccessible.');
  
  app.listen(port, () => {
    console.log(`API Server is running on port ${port}`);
  });
};


