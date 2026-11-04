import { db } from './index.js';
import { settingsTable, globalSettingsTable } from './schema.js';
import { eq } from 'drizzle-orm';
import dotenv from 'dotenv';
import seedData from '../config/banned-words.json' with { type: 'json' };

dotenv.config({ quiet: true });

export async function getGlobalSettings() {
  const rows = await db.select().from(globalSettingsTable).where(eq(globalSettingsTable.id, 1));
  
  if (rows.length === 0) {
    const defaultSettings = { 
      id: 1, 
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null
    };
    await db.insert(globalSettingsTable).values(defaultSettings);
    return defaultSettings;
  }
  
  const settings = rows[0];
  
  return {
    ...settings,
    telegramBotToken: settings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || null
  };
}

export async function getConnections() {
  const rows = await db.select().from(settingsTable);
  
  if (rows.length === 0) {
    let seedBannedWords = seedData || [];
    const defaultSettings = { 
      name: 'Default Connection',
      postingSlots: [],
      bannedWords: seedBannedWords as { word: string, replacement: string, type: 'exact' | 'partial' }[],
      cronIntervalMinutes: 30, 
      cronStartHour: 6, 
      cronEndHour: 23,
      editorialGuidelines: process.env.EDITORIAL_GUIDELINES || null,
      lastAutoPublishAt: null,
      logoImageUrl: process.env.LOGO_IMAGE_URL || null,
      ctaImageUrl: process.env.CTA_IMAGE_URL || null,
      bufferApiKey: process.env.BUFFER_API_KEY || null,
      bufferChannelId: process.env.BUFFER_CHANNEL_ID || null,
      bufferChannelNetwork: 'instagram', // Default fallback
    };
    const [inserted] = await db.insert(settingsTable).values(defaultSettings).returning();
    return [inserted];
  }
  
  return rows;
}

export async function getConnection(id: number) {
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.id, id));
  if (rows.length === 0) return null;
  return rows[0];
}

// Keep a backward compatible getSettings function if possible, mapping to the first connection
export async function getSettings() {
  const connections = await getConnections();
  return connections[0];
}
