import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import dotenv from 'dotenv';
import { startServer } from './server.js';
import { db } from './db/index.js';
import { jobsTable, ideasTable } from './db/schema.js';
import { getGlobalSettings, getConnections, getConnection } from './db/settings.js';
import { TEMPLATES } from './templates.js';
import { formatQueueConfirmation } from './utils/formatters.js';

const TEMPLATE_SHORT_CODES: Record<string, string> = {
  'carousel_dark': 'image:poros.perjuangan:carousel_dark',
  'carousel_multi': 'image:poros.perjuangan:carousel_multi_images',
  'single_page': 'image:poros.perjuangan:single_page',
};

const TEMPLATE_TO_SHORT: Record<string, string> = {
  'image:poros.perjuangan:carousel_dark': 'carousel_dark',
  'image:poros.perjuangan:carousel_multi_images': 'carousel_multi',
  'image:poros.perjuangan:single_page': 'single_page',
  'image:kabar.perjuangan:carousel_dark': 'carousel_dark',
  'image:kabar.perjuangan:carousel_multi_images': 'carousel_multi',
  'image:kabar.perjuangan:single_page': 'single_page',
};

function resolveTemplateId(code: string): string {
  return TEMPLATE_SHORT_CODES[code] || code;
}

function getShortTemplateCode(templateId: string): string {
  return TEMPLATE_TO_SHORT[templateId] || templateId;
}
import { eq, sql } from 'drizzle-orm';
import { InteractiveMenu } from './utils/interactiveMenu.js';
import dns from 'dns';
import { uploadToS3 } from './s3.js';
import fs from 'fs/promises';

dns.setDefaultResultOrder('ipv4first');

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
startServer(PORT);

const globalSettings = await getGlobalSettings();
const botToken = globalSettings.telegramBotToken;
if (!botToken) {
  console.error('TELEGRAM_BOT_TOKEN must be provided in global settings (Database) or .env');
  process.exit(1);
}

const telegramApiRoot = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';

const bot = new Telegraf(botToken, {
  telegram: {
    apiRoot: telegramApiRoot
  }
});

const mediaGroupAccumulator = new Map<string, { timer: NodeJS.Timeout, items: { fileId: string, caption?: string, msgId: number, type: 'image', mimeType?: string }[] }>();

async function uploadTelegramMediaToS3(url: string, mimeType?: string): Promise<string> {
  console.log(`[Bot] Fetching media from URL: ${url}`);
  let buffer: Buffer;

  if (url.startsWith('file://')) {
    const parsedUrl = new URL(url);
    const filePath = decodeURIComponent(parsedUrl.pathname);
    buffer = await fs.readFile(filePath);
  } else {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch media: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  }
  
  let ext = '.jpg';
  if (mimeType === 'image/png') ext = '.png';
  else if (mimeType === 'image/webp') ext = '.webp';
  else if (!mimeType && url.includes('.')) {
      const extMatch = url.match(/\.([a-zA-Z0-9]+)(\?|$)/);
      if (extMatch) ext = `.${extMatch[1]}`;
  }

  const resolvedMimeType = mimeType || 'image/jpeg';

  return uploadToS3(buffer, resolvedMimeType, ext);
}

async function promptConnectionSelection(ctx: any, ideaId: number) {
  const connections = await getConnections();
  
  if (connections.length === 1) {
    // Only one connection, auto-assign
    await db.update(ideasTable).set({ connectionId: connections[0].id }).where(eq(ideasTable.id, ideaId));
    await askForTemplate(ctx, ideaId);
    return;
  }

  if (connections.length === 0) {
    return ctx.reply('No connections configured. Please set up a connection in the dashboard first.');
  }
  const buttons = connections.map(conn => [{ text: conn.name, callback_data: `select_conn_${ideaId}_${conn.id}` }]);
  buttons.push([{ text: '❌ Cancel', callback_data: `cancel_idea_${ideaId}` }]);

  await InteractiveMenu.send(ctx, 'Which account should I queue this idea for?', buttons);
}

async function askForTemplate(ctx: any, ideaId: number) {
  const [idea] = await db.select().from(ideasTable).where(eq(ideasTable.id, ideaId));
  if (!idea) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Ide tidak ditemukan.');
    return;
  }

  const availableTemplates = Object.values(TEMPLATES);

  const templateButtons = availableTemplates.map(t => {
    return [{ text: t.name, callback_data: `convert_${ideaId}_${getShortTemplateCode(t.id)}` }];
  });

  templateButtons.push([{ text: '❌ Batal', callback_data: `cancel_idea_${ideaId}` }]);

  const messageText = 'Pilih template yang ingin digunakan:';
  
  if (ctx.callbackQuery) {
    await InteractiveMenu.update(ctx, messageText, templateButtons);
  } else {
    await InteractiveMenu.send(ctx, messageText, templateButtons);
  }
}

async function askForHeroStyle(ctx: any, ideaId: number, templateId: string) {
  const shortCode = getShortTemplateCode(templateId);
  const styleButtons = [
    [
      { text: '🌑 Dark Dramatize (Chiaroscuro)', callback_data: `hs_${ideaId}_${shortCode}_dark` }
    ],
    [
      { text: '🌟 4K Realistic (Natural Photo)', callback_data: `hs_${ideaId}_${shortCode}_real` }
    ],
    [
      { text: '⬅️ Kembali ke Template', callback_data: `back_tmpl_${ideaId}` },
      { text: '❌ Batal', callback_data: `cancel_idea_${ideaId}` }
    ]
  ];

  const templateObj = (TEMPLATES as any)[templateId];
  const templateName = templateObj?.name || 'Carousel';
  const messageText = `Template: <b>${templateName}</b>\n\nPilih gaya <b>Hero Image (Cover)</b> yang ingin digunakan:`;

  if (ctx.callbackQuery) {
    await InteractiveMenu.update(ctx, messageText, styleButtons, 'HTML');
  } else {
    await InteractiveMenu.send(ctx, messageText, styleButtons, 'HTML');
  }
}

// Configure Persistent Telegram Menu Button to open Mini App Dashboard
if (process.env.APP_URL) {
  bot.telegram.setChatMenuButton({
    menuButton: {
      type: 'web_app',
      text: '📊 Dashboard',
      web_app: { url: process.env.APP_URL }
    }
  }).then(() => {
    console.log(`[Bot] Telegram Menu Button set to Web App: ${process.env.APP_URL}`);
  }).catch((err: any) => {
    console.warn('[Bot] Could not set chat menu button:', err.message);
  });
}

// /start command with welcome message and inline Mini App button
bot.command('start', async (ctx) => {
  const welcomeText = `👋 <b>Selamat datang di Bot Poros Perjuangan!</b>\n\nKirimkan teks berita, link, atau foto untuk membuat konten Instagram carousel otomatis.\n\nAnda juga dapat membuka <b>Web Dashboard</b> langsung di Telegram melalui tombol di bawah atau tombol menu di kiri bawah:`;
  const buttons = process.env.APP_URL ? [
    [{ text: '📊 Buka Dashboard', web_app: { url: process.env.APP_URL } }]
  ] : [];

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined
  });
});

// /dashboard command to open Mini App
bot.command('dashboard', async (ctx) => {
  if (!process.env.APP_URL) {
    return ctx.reply('APP_URL belum dikonfigurasi di environment server.');
  }

  await ctx.reply('Klik tombol di bawah untuk membuka Web Dashboard:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Buka Dashboard', web_app: { url: process.env.APP_URL } }]
      ]
    }
  });
});

bot.on(message('text'), async (ctx) => {
  const chatId = ctx.chat.id.toString();
  
  let text = ctx.message.text;
  if (ctx.message.entities) {
    let offset = 0;
    const entities = ctx.message.entities;
    for (const entity of entities) {
      if (entity.type === 'text_link') {
        const linkText = text.substring(entity.offset + offset, entity.offset + entity.length + offset);
        const url = entity.url;
        const replacement = `${linkText} (${url})`;
        text = text.substring(0, entity.offset + offset) + replacement + text.substring(entity.offset + entity.length + offset);
        offset += replacement.length - linkText.length;
      }
    }
  }
  
  try {
    const connections = await getConnections();
    const defaultConnectionId = connections.length === 1 ? connections[0].id : null;

    const [idea] = await db.insert(ideasTable).values({
      connectionId: defaultConnectionId,
      chatId,
      messageId: ctx.message.message_id,
      text,
      media: [],
      status: 'pending'
    }).returning();
    
    if (defaultConnectionId) {
       await InteractiveMenu.send(ctx, 'Ide tersimpan. Apakah Anda ingin membuat konten dari ide ini?', [
         [{ text: '✅ Ya, Buat Konten', callback_data: `make_post_${idea.id}` }],
         [{ text: '❌ Batal', callback_data: `cancel_idea_${idea.id}` }]
       ]);
    } else {
      await promptConnectionSelection(ctx, idea.id);
    }
  } catch (err: any) {
    console.error('[Bot] Error saving text idea:', err);
    await ctx.reply('Terjadi kesalahan sistem saat menyimpan antrean.');
  }
});

async function handlePhotoMessage(ctx: any) {
  const chatId = ctx.chat.id.toString();

  const baseCaption = ctx.message.caption || '';
  let caption = baseCaption;
  
  if (ctx.message.caption_entities) {
    let offset = 0;
    const entities = ctx.message.caption_entities;
    for (const entity of entities) {
      if (entity.type === 'text_link') {
        const linkText = caption.substring(entity.offset + offset, entity.offset + entity.length + offset);
        const url = entity.url;
        const replacement = `${linkText} (${url})`;
        caption = caption.substring(0, entity.offset + offset) + replacement + caption.substring(entity.offset + entity.length + offset);
        offset += replacement.length - linkText.length;
      }
    }
  }
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;
  const mimeType = 'image/jpeg';
  
  const mediaGroupId = ctx.message.media_group_id;
  
  if (mediaGroupId) {
    console.log(`[Bot] Received photo part of media group ${mediaGroupId}`);
    const flushMediaGroup = async () => {
      const groupData = mediaGroupAccumulator.get(mediaGroupId);
      mediaGroupAccumulator.delete(mediaGroupId);
      if (!groupData || groupData.items.length === 0) return;
      
      console.log(`[Bot] Processing accumulated media group ${mediaGroupId} with ${groupData.items.length} items`);
      
      try {
        groupData.items.sort((a, b) => a.msgId - b.msgId);
        
        const mediaItems = [];
        for (const item of groupData.items) {
          let url = '';
          let retries = 3;
          while (retries > 0) {
            try {
              const fileUrl = await ctx.telegram.getFileLink(item.fileId);
              const telegramUrl = fileUrl.toString();
              url = await uploadTelegramMediaToS3(telegramUrl, item.mimeType);
              break;
            } catch (e: any) {
              retries--;
              console.warn(`[Bot] Failed to download/upload ${item.fileId}, retries left: ${retries}. Error: ${e.message}`, e.cause);
              if (retries === 0) throw e;
              await new Promise(res => setTimeout(res, 1000));
            }
          }
          mediaItems.push({ type: item.type, url, mimeType: item.mimeType });
        }
        
        const groupCaption = groupData.items.find(item => item.caption)?.caption || 'No specific text provided, analyze the media context if possible.';
        
        const connections = await getConnections();
        const defaultConnectionId = connections.length === 1 ? connections[0].id : null;

        const [idea] = await db.insert(ideasTable).values({
          connectionId: defaultConnectionId,
          chatId,
          messageId: groupData.items[0].msgId,
          text: groupCaption,
          media: mediaItems,
          status: 'pending'
        }).returning();
        
        if (defaultConnectionId) {
          await InteractiveMenu.send(ctx, 'Ide (album) tersimpan. Apakah Anda ingin membuat konten dari ide ini?', [
            [{ text: '✅ Ya, Buat Konten', callback_data: `make_post_${idea.id}` }],
            [{ text: '❌ Batal', callback_data: `cancel_idea_${idea.id}` }]
          ], 'Markdown', { reply_to_message_id: groupData.items[0].msgId });
        } else {
          await promptConnectionSelection(ctx, idea.id);
        }
        
      } catch (error) {
        console.error('[Bot] Error saving media group idea:', error);
        try { await ctx.reply('Terjadi kesalahan sistem saat menyimpan antrean album.'); } catch (e) {}
      }
    };

    let group = mediaGroupAccumulator.get(mediaGroupId);
    if (!group) {
      group = {
        items: [],
        timer: setTimeout(flushMediaGroup, 2000)
      };
      mediaGroupAccumulator.set(mediaGroupId, group);
    } else {
      clearTimeout(group.timer);
      group.timer = setTimeout(flushMediaGroup, 2000);
    }
    
    group.items.push({
      fileId,
      caption: caption,
      msgId: ctx.message.message_id,
      type: 'image',
      mimeType
    });
    
    return;
  }

  console.log(`[Bot] Received single photo message from ${ctx.chat.id}`);
  let finalS3Url: string | undefined = undefined;
  let retries = 3;
  while (retries > 0) {
    try {
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      const telegramUrl = fileUrl.toString();
      finalS3Url = await uploadTelegramMediaToS3(telegramUrl, mimeType);
      break;
    } catch (e: any) {
      retries--;
      console.warn(`[Bot] Failed to download/upload ${fileId}, retries left: ${retries}. Error: ${e.message}`, e.cause);
      if (retries === 0) {
        await ctx.reply('❌ Gagal mengunduh media dari Telegram. Silakan coba lagi.');
        return;
      }
      await new Promise(res => setTimeout(res, 1000));
    }
  }
  
  if (!finalS3Url) return;
  const text = caption ? caption : 'No specific text provided, analyze the media context if possible.';
  
  try {
    const connections = await getConnections();
    const defaultConnectionId = connections.length === 1 ? connections[0].id : null;

    const [idea] = await db.insert(ideasTable).values({
      connectionId: defaultConnectionId,
      chatId,
      messageId: ctx.message.message_id,
      text,
      media: [{ type: 'image', url: finalS3Url, mimeType }],
      status: 'pending'
    }).returning();
    
    if (defaultConnectionId) {
      await InteractiveMenu.send(ctx, 'Ide media tersimpan. Apakah Anda ingin membuat konten dari ide ini?', [
        [{ text: '✅ Ya, Buat Konten', callback_data: `make_post_${idea.id}` }],
        [{ text: '❌ Batal', callback_data: `cancel_idea_${idea.id}` }]
      ], 'Markdown', { reply_to_message_id: ctx.message.message_id });
    } else {
       await promptConnectionSelection(ctx, idea.id);
    }
  } catch (error) {
    console.error(`[Bot] Error saving single media idea:`, error);
    try { await ctx.reply('Terjadi kesalahan sistem saat menyimpan antrean media.'); } catch (e) {}
  }
}

bot.on('callback_query', async (ctx: any) => {
  try {
    const callbackData = ctx.callbackQuery.data;
    
    if (callbackData.startsWith('make_post_')) {
      const ideaId = parseInt(callbackData.replace('make_post_', ''), 10);
      
      const [idea] = await db.select().from(ideasTable).where(eq(ideasTable.id, ideaId));
      if (!idea) {
        return ctx.answerCbQuery('Ide tidak ditemukan.');
      }
      if (idea.status !== 'pending') {
         return ctx.answerCbQuery('Ide ini sudah diproses.');
      }

      await askForTemplate(ctx, ideaId);
      await ctx.answerCbQuery();

    } else if (callbackData.startsWith('select_conn_')) {
      const match = callbackData.match(/^select_conn_(\d+)_(\d+)$/);
      if (!match) return ctx.answerCbQuery('Format data tidak valid.');
      
      const ideaId = parseInt(match[1], 10);
      const connId = parseInt(match[2], 10);

      await db.update(ideasTable).set({ connectionId: connId }).where(eq(ideasTable.id, ideaId));
      
      await askForTemplate(ctx, ideaId);
      await ctx.answerCbQuery('Connection selected');

    } else if (callbackData.startsWith('convert_')) {
      const match = callbackData.match(/^convert_(\d+)_(.+)$/);
      if (!match) return ctx.answerCbQuery('Format data tidak valid.');
      
      const ideaId = parseInt(match[1], 10);
      const rawTemplate = match[2];
      const templateId = resolveTemplateId(rawTemplate);

      const [idea] = await db.select().from(ideasTable).where(eq(ideasTable.id, ideaId));
      if (!idea) {
        return ctx.answerCbQuery('Ide tidak ditemukan.');
      }
      if (idea.status !== 'pending') {
         return ctx.answerCbQuery('Ide ini sudah diproses.');
      }
      if (!idea.connectionId) {
        return ctx.answerCbQuery('Silakan pilih akun/connection terlebih dahulu.');
      }

      // Untuk template image/carousel, tanyakan style hero image
      await askForHeroStyle(ctx, ideaId, templateId);
      await ctx.answerCbQuery();
      
    } else if (callbackData.startsWith('hs_') || callbackData.startsWith('style_')) {
      let ideaId: number;
      let templateId: string;
      let heroStyle: string;

      const hsMatch = callbackData.match(/^hs_(\d+)_(.+?)_(dark|real)$/);
      if (hsMatch) {
        ideaId = parseInt(hsMatch[1], 10);
        templateId = resolveTemplateId(hsMatch[2]);
        heroStyle = hsMatch[3] === 'real' ? '4K-Enhance' : 'Dark-Dramatize';
      } else {
        const styleMatch = callbackData.match(/^style_(\d+)_(.+?)_(Dark-Dramatize|4K-Enhance)$/);
        if (!styleMatch) return ctx.answerCbQuery('Format data tidak valid.');
        ideaId = parseInt(styleMatch[1], 10);
        templateId = resolveTemplateId(styleMatch[2]);
        heroStyle = styleMatch[3];
      }

      const [existingIdea] = await db.select().from(ideasTable).where(eq(ideasTable.id, ideaId));
      if (!existingIdea) return ctx.answerCbQuery('Ide tidak ditemukan.');
      if (!existingIdea.connectionId) return ctx.answerCbQuery('Silakan pilih akun/connection terlebih dahulu.');

      const [idea] = await db.update(ideasTable)
        .set({ status: 'converted' })
        .where(sql`${ideasTable.id} = ${ideaId} AND ${ideasTable.status} = 'pending'`)
        .returning();

      if (!idea) return ctx.answerCbQuery('Ide ini sudah diproses.');

      await db.insert(jobsTable).values({
        connectionId: idea.connectionId,
        chatId: idea.chatId,
        messageId: idea.messageId,
        text: idea.text,
        media: idea.media,
        templateId: templateId,
        heroStyle: heroStyle,
        status: 'pending'
      });
      const connection = idea.connectionId ? await getConnection(idea.connectionId) : null;
      const hasImage = idea.media && Array.isArray(idea.media) && idea.media.some((m: any) => m.type === 'image');
      const successMsg = formatQueueConfirmation({
        hasImage,
        heroStyle,
        accountName: connection?.name,
        templateId,
      });
      await InteractiveMenu.finalize(ctx, successMsg, 'HTML');
      
    } else if (callbackData.startsWith('back_tmpl_') || callbackData.startsWith('back_template_')) {
      const ideaId = parseInt(callbackData.replace(/^back_(tmpl|template)_/, ''), 10);
      await askForTemplate(ctx, ideaId);
      await ctx.answerCbQuery();
    } else if (callbackData.startsWith('cancel_idea_')) {
      const ideaId = parseInt(callbackData.replace('cancel_idea_', ''), 10);
      await InteractiveMenu.finalize(ctx, '⏸️ Ide disimpan. Bisa diproses nanti di dashboard.');
    }
  } catch (error) {
    console.error('[Bot] Error in callback_query:', error);
    try { await ctx.answerCbQuery('Terjadi kesalahan.'); } catch (e) {}
  }
});

bot.on(message('photo'), (ctx) => handlePhotoMessage(ctx));

const startBotWithRetry = async (retries = 10, delayMs = 3000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log('Bot is running in automated mode...');
      return;
    } catch (err: any) {
      console.error(`[Bot] Failed to launch bot (Attempt ${i + 1}/${retries}): ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
};

startBotWithRetry().catch(err => {
  console.error('[Bot] Failed to start after multiple retries', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

