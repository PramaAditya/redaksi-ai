import { pgTable, text, serial, timestamp, jsonb, bigint, integer } from 'drizzle-orm/pg-core';

export const globalSettingsTable = pgTable('global_settings', {
  id: integer('id').primaryKey(), // Always 1
  telegramBotToken: text('telegram_bot_token'),
});

export const settingsTable = pgTable('settings', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().default('Default Connection'),
  logoImageUrl: text('logo_image_url'),
  ctaImageUrl: text('cta_image_url'),
  bufferApiKey: text('buffer_api_key'),
  bufferChannelId: text('buffer_channel_id'),
  bufferChannelNetwork: text('buffer_channel_network').default('instagram'),
  editorialGuidelines: text('editorial_guidelines'),
  postingSlots: jsonb('posting_slots').$type<{ day: string, time: string }[]>().default([]).notNull(),
  bannedWords: jsonb('banned_words').$type<{ word: string, replacement: string, type: 'exact' | 'partial' }[]>().default([]).notNull(),
  cronIntervalMinutes: integer('cron_interval_minutes').default(30).notNull(),
  cronStartHour: integer('cron_start_hour').default(6).notNull(),
  cronEndHour: integer('cron_end_hour').default(23).notNull(),
  lastAutoPublishAt: timestamp('last_auto_publish_at'),
});

export const queueTable = pgTable('queue', {
  id: serial('id').primaryKey(),
  connectionId: integer('connection_id').references(() => settingsTable.id, { onDelete: 'cascade' }),
  sortOrder: serial('sort_order'),
  templateId: text('template_id').notNull().default('image:poros.perjuangan:carousel_dark'),
  templateData: jsonb('template_data').$type<any>().notNull().default({}),
  text: text('text').notNull(),
  media: jsonb('media').$type<{ type: 'image', url: string }[]>().notNull(),
  publishMetadata: jsonb('publish_metadata').$type<any>().notNull().default({}),
  status: text('status').notNull().default('pending'), // pending, publishing, buffering, published, error
  chatId: text('chat_id'),
  messageId: bigint('message_id', { mode: 'number' }),
  bufferPostId: text('buffer_post_id'),
  postUrl: text('post_url'),
  retryCount: integer('retry_count').default(0).notNull(),
  nextRetryAt: timestamp('next_retry_at'),
  errorLog: text('error_log'),
  researchResult: text('research_result'),
  agentInsights: jsonb('agent_insights').$type<Record<string, string>>().default({}).notNull(),
  rawInput: text('raw_input'),
  scheduledAt: timestamp('scheduled_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  publishedAt: timestamp('published_at'),
});

export const ideasTable = pgTable('ideas', {
  id: serial('id').primaryKey(),
  connectionId: integer('connection_id').references(() => settingsTable.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull(),
  messageId: bigint('message_id', { mode: 'number' }).notNull(),
  text: text('text').notNull(),
  media: jsonb('media').$type<{ type: 'image', url: string, mimeType?: string }[]>().default([]).notNull(),
  status: text('status').notNull().default('pending'), // pending, converted, rejected
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const jobsTable = pgTable('jobs', {
  id: serial('id').primaryKey(),
  connectionId: integer('connection_id').references(() => settingsTable.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull(),
  messageId: bigint('message_id', { mode: 'number' }).notNull(),
  templateId: text('template_id').notNull().default('image:poros.perjuangan:carousel_dark'),
  heroStyle: text('hero_style').default('Dark-Dramatize'),
  text: text('text').notNull(),
  media: jsonb('media').$type<{ type: 'image', url: string, mimeType?: string }[]>().default([]).notNull(),
  status: text('status').notNull().default('pending'), // pending, processing, completed, error
  errorLog: text('error_log'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
