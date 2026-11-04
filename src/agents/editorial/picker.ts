import { z } from 'zod';
import { generateObject } from 'ai';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  settingsTable,
  queueTable,
  jobsTable,
  ideasTable,
  DEFAULT_NEWS_RADAR_CONFIG,
  type NewsRadarConfig,
} from '../../db/schema.js';
import { getConnection } from '../../db/settings.js';
import { googleAI, mapWithConcurrency, SLIDE_CONCURRENCY } from '../../utils.js';
import { sanitizeSourceUrl, getCleanDomain } from '../../utils/urlSanitizer.js';
import {
  buildGoogleNewsRssUrl,
  fetchRssFeedArticles,
  resolveGoogleNewsUrl,
  type RawRssArticle,
} from '../../utils/googleNewsDecoder.js';

export interface SelectedRadarStory {
  title: string;
  links: string[];
  pitch: string;
}

const pickerSchema = z.object({
  ranked_stories: z
    .array(
      z.object({
        title: z
          .string()
          .describe('Judul utama berita yang tajam, faktual, dan representatif dalam Bahasa Indonesia'),
        links: z
          .array(z.string())
          .min(1)
          .describe(
            'Semua URL dari daftar kandidat yang membahas peristiwa/isu yang SAMA (kelompokkan berita kembar dari berbagai media ke dalam array ini)'
          ),
        pitch: z
          .string()
          .describe(
            'Penjelasan singkat 1-2 kalimat ala Kepala Redaksi mengapa isu ini sangat menarik/viral untuk audiens akun ini dan sudut pandang (angle) apa yang harus diangkat'
          ),
      })
    )
    .min(1)
    .max(5),
});

function inferDefaultKeywords(connectionName: string, guidelines: string): string[] {
  const combined = `${connectionName} ${guidelines}`.toLowerCase();
  if (combined.includes('geopolitik') || combined.includes('internasional') || combined.includes('global')) {
    return ['Geopolitik', 'Timur Tengah', 'Laut China Selatan', 'BRICS', 'Konflik Militer', 'Perang Dagang'];
  }
  return ['Pemerintah Indonesia', 'Kebijakan Ekonomi', 'DPR', 'Politik Nasional', 'Hukum Indonesia'];
}

/**
 * Pure AI Chief Editor Picker function:
 * Deduplicates semantically against recentTitles, clusters duplicate event articles into `links[]`,
 * and ranks top stories aligned with the account's editorial guidelines.
 */
export async function runPickerAgent(
  candidateArticles: RawRssArticle[],
  recentTopics: string[],
  editorialGuidelines: string,
  maxStories = 3
): Promise<SelectedRadarStory[]> {
  if (candidateArticles.length === 0) return [];

  const recentListText =
    recentTopics.length > 0
      ? recentTopics.slice(0, 40).map((t, i) => `${i + 1}. ${t}`).join('\n')
      : '(Belum ada riwayat topik)';

  const systemPrompt = `Anda adalah Kepala Redaksi (Chief Editor) dan Spesialis Pertumbuhan Media Sosial Instagram di Indonesia.
Tugas Anda adalah meninjau daftar kandidat artikel berita terbaru dari RSS, mengelompokkan berita kembar (dari berbagai media yang membahas peristiwa yang sama), dan memilih TOP ${maxStories} berita terbaik yang paling berpotensi viral.

ATURAN KRITIS:
1. KESESUAIAN REDAKSI (EDITORIAL ALIGNMENT):
Saring dan urutkan berita berdasarkan karakter & pedoman redaksi akun berikut:
${editorialGuidelines ? `--- PEDOMAN REDAKSI ---\n${editorialGuidelines}\n-----------------------` : 'Berita berdampak luas, memicu diskusi publik, dan relevan bagi pembaca Indonesia.'}

2. DEDUPLIKASI SEMANTIK (ANTI TOPIK KEMBAR):
Di bawah ini adalah daftar topik/judul konten yang SUDAH pernah dibuat atau ditolak baru-baru ini.
Anda DILARANG KERAS memilih artikel kandidat yang membahas peristiwa, insiden, atau isu yang sama dengan daftar di bawah ini (walaupun judul atau medianya berbeda):
--- RIWAYAT TOPIK YANG SUDAH ADA (JANGAN DIULANG) ---
${recentListText}
-----------------------------------------------------

3. MULTI-SOURCE CLUSTERING:
Jika ada 2-5 artikel kandidat dari media berbeda yang membahas peristiwa yang sama, gabungkan SEMUA URL mereka ke dalam properti \`links\` pada satu item cerita yang sama agar tim riset kami memiliki rujukan multi-sumber.`;

  const indexedCandidates = candidateArticles.slice(0, 40).map((a, idx) => ({
    id: idx + 1,
    title: a.title,
    source: a.source,
    pubDate: a.pubDate,
    link: a.link,
    snippet: a.description,
  }));

  const modelName =
    process.env.PICKER_MODEL ||
    process.env.MIDDLE_MODEL ||
    process.env.CONTENT_WRITER_MODEL ||
    'gemini-3-flash-preview';

  const { object } = await generateObject({
    model: googleAI(modelName),
    system: systemPrompt,
    schema: pickerSchema,
    prompt: `Daftar Kandidat Berita Terbaru:\n${JSON.stringify(indexedCandidates, null, 2)}`,
  });

  return (object.ranked_stories || []).slice(0, maxStories);
}

/**
 * Full end-to-end News Radar scan for a specific connection:
 * 1. Builds RSS URLs from keywords + custom RSS feeds
 * 2. Fetches & pre-filters against existing DB queue/jobs/ideas
 * 3. Runs AI Chief Editor Picker (`runPickerAgent`)
 * 4. Decodes Google News redirect URLs (`resolveGoogleNewsUrl`)
 * 5. Inserts curated story clusters into `ideasTable` (and optionally queues #1 in Autopilot mode)
 */
export async function scanNewsForConnection(
  connectionId: number,
  options: { triggerSource?: 'manual' | 'cron'; maxStoriesOverride?: number } = {}
) {
  const connection = await getConnection(connectionId);
  if (!connection) {
    throw new Error(`Connection ${connectionId} not found`);
  }

  const rawRadarConfig = (connection as any).newsRadarConfig || {};
  const radarConfig: NewsRadarConfig = {
    ...DEFAULT_NEWS_RADAR_CONFIG,
    ...rawRadarConfig,
  };

  const maxStories = options.maxStoriesOverride || radarConfig.maxStoriesPerScan || 3;
  const effectiveKeywords =
    radarConfig.keywords && radarConfig.keywords.length > 0
      ? radarConfig.keywords
      : inferDefaultKeywords(connection.name || '', connection.editorialGuidelines || '');

  const feedUrls: string[] = [];
  if (effectiveKeywords.length > 0) {
    feedUrls.push(buildGoogleNewsRssUrl(effectiveKeywords, radarConfig.language || 'id'));
  }
  if (Array.isArray(radarConfig.customRssUrls)) {
    for (const customUrl of radarConfig.customRssUrls) {
      if (customUrl && customUrl.trim().startsWith('http')) {
        feedUrls.push(customUrl.trim());
      }
    }
  }

  console.log(`[NewsRadar] Scanning ${feedUrls.length} feed(s) for connection #${connectionId} (${connection.name})...`);
  const feedResults = await Promise.all(feedUrls.map((url) => fetchRssFeedArticles(url, 30)));
  const allRawArticles = feedResults.flat();

  // Deduplicate within the raw RSS batch by title/link
  const seenBatchKeys = new Set<string>();
  const uniqueBatchArticles: RawRssArticle[] = [];
  for (const art of allRawArticles) {
    const key = `${art.title.toLowerCase().trim()}|${art.link}`;
    if (!seenBatchKeys.has(key)) {
      seenBatchKeys.add(key);
      uniqueBatchArticles.push(art);
    }
  }

  // Stage 1: Fetch recent posts, jobs, and ideas for SQL pre-filtering & semantic deduplication
  const [recentQueue, recentJobs, recentIdeas] = await Promise.all([
    db
      .select({ text: queueTable.text, rawInput: queueTable.rawInput, templateData: queueTable.templateData })
      .from(queueTable)
      .where(eq(queueTable.connectionId, connectionId))
      .orderBy(desc(queueTable.createdAt))
      .limit(30),
    db
      .select({ text: jobsTable.text })
      .from(jobsTable)
      .where(eq(jobsTable.connectionId, connectionId))
      .orderBy(desc(jobsTable.createdAt))
      .limit(20),
    db
      .select({ text: ideasTable.text, metadata: ideasTable.metadata })
      .from(ideasTable)
      .where(eq(ideasTable.connectionId, connectionId))
      .orderBy(desc(ideasTable.createdAt))
      .limit(40),
  ]);

  const existingTextBlob = [
    ...recentQueue.map((q) => `${q.rawInput || ''} ${q.text || ''} ${(q.templateData as any)?.title || ''}`),
    ...recentJobs.map((j) => j.text || ''),
    ...recentIdeas.map((i) => `${i.text || ''} ${(i.metadata as any)?.headline || ''}`),
  ]
    .join('\n')
    .toLowerCase();

  const recentTopicHeadlines: string[] = [];
  for (const q of recentQueue) {
    const title = (q.templateData as any)?.title || q.text?.split('\n')[0];
    if (title) recentTopicHeadlines.push(String(title).replace(/<[^>]+>|\*\*/g, '').trim());
  }
  for (const i of recentIdeas) {
    const headline = (i.metadata as any)?.headline || i.text?.split('\n')[0];
    if (headline) recentTopicHeadlines.push(String(headline).trim());
  }

  // Filter out exact title or link matches
  const prefilteredCandidates = uniqueBatchArticles.filter((art) => {
    const normTitle = art.title.toLowerCase().trim();
    if (normTitle.length > 12 && existingTextBlob.includes(normTitle)) {
      return false;
    }
    if (existingTextBlob.includes(art.link.toLowerCase())) {
      return false;
    }
    return true;
  });

  if (prefilteredCandidates.length === 0) {
    return {
      scannedCount: uniqueBatchArticles.length,
      insertedIdeas: [],
      autoQueuedJob: null,
      message: 'No new articles found that have not already been covered.',
    };
  }

  // Stage 2: AI Chief Editor Picker
  const pickedStories = await runPickerAgent(
    prefilteredCandidates,
    recentTopicHeadlines,
    connection.editorialGuidelines || '',
    maxStories
  );

  // Stage 3: Resolve Google News redirect URLs in parallel for selected stories
  const insertedIdeas = [];
  for (let rankIdx = 0; rankIdx < pickedStories.length; rankIdx++) {
    const story = pickedStories[rankIdx];
    const resolvedLinks = await mapWithConcurrency(story.links.slice(0, 4), SLIDE_CONCURRENCY, async (rawLink) => {
      const decoded = await resolveGoogleNewsUrl(rawLink);
      return sanitizeSourceUrl(decoded) || decoded;
    });

    const uniqueLinks = [...new Set(resolvedLinks.filter(Boolean))];
    const sourcesMeta = uniqueLinks.map((url) => {
      const matchingRaw = prefilteredCandidates.find((c) => c.link === url || story.links.includes(c.link));
      return {
        url,
        domain: getCleanDomain(url) || matchingRaw?.source || 'news',
        title: matchingRaw?.title,
      };
    });

    const ideaText = `${story.title}\n\nSumber Rujukan:\n${uniqueLinks.join('\n')}`;

    const [inserted] = await db
      .insert(ideasTable)
      .values({
        connectionId,
        chatId: 'NEWS_RADAR',
        messageId: Date.now() + rankIdx,
        text: ideaText,
        media: [],
        status: 'pending',
        metadata: {
          sourceType: 'radar',
          headline: story.title,
          pitch: story.pitch,
          sources: sourcesMeta,
          rank: rankIdx + 1,
        },
      })
      .returning();

    insertedIdeas.push(inserted);
  }

  // Update lastScannedAt timestamp
  const updatedConfig: NewsRadarConfig = {
    ...radarConfig,
    keywords: effectiveKeywords,
    lastScannedAt: new Date().toISOString(),
  };
  await db
    .update(settingsTable)
    .set({ newsRadarConfig: updatedConfig })
    .where(eq(settingsTable.id, connectionId));

  // Optional Stage 4: Full Autopilot Mode — if queue + active jobs < threshold, auto-convert top story!
  let autoQueuedJob: any = null;
  if (radarConfig.mode === 'autopilot' && insertedIdeas.length > 0) {
    const [pendingQueueCountRes, activeJobsCountRes] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(queueTable)
        .where(sql`connection_id = ${connectionId} AND status = 'pending'`),
      db
        .select({ count: sql<number>`count(*)` })
        .from(jobsTable)
        .where(sql`connection_id = ${connectionId} AND status IN ('pending', 'processing')`),
    ]);

    const totalPending =
      Number(pendingQueueCountRes[0]?.count || 0) + Number(activeJobsCountRes[0]?.count || 0);

    if (totalPending < (radarConfig.minPendingQueueThreshold || 2)) {
      const topIdea = insertedIdeas[0];
      const defaultTemplate =
        radarConfig.defaultTemplateId ||
        (connection.name?.toLowerCase().includes('geopolitik')
          ? 'image:aa.geopolitik:carousel_analysis'
          : 'image:poros.perjuangan:carousel_dark');

      const [claimed] = await db
        .update(ideasTable)
        .set({ status: 'converted' })
        .where(sql`${ideasTable.id} = ${topIdea.id} AND ${ideasTable.status} = 'pending'`)
        .returning();

      if (claimed) {
        const [job] = await db
          .insert(jobsTable)
          .values({
            connectionId,
            chatId: 'DASHBOARD',
            messageId: Date.now(),
            templateId: defaultTemplate,
            heroStyle: radarConfig.defaultHeroStyle || 'Dark-Dramatize',
            text: claimed.text,
            media: [],
            status: 'pending',
          })
          .returning();

        autoQueuedJob = job;
        topIdea.status = 'converted';
        console.log(
          `[NewsRadar:Autopilot] Pending queue (${totalPending}) < threshold (${radarConfig.minPendingQueueThreshold}). Auto-queued top story "${storyTitlePreview(claimed.text)}" as Job #${job.id}!`
        );
      }
    }
  }

  return {
    scannedCount: uniqueBatchArticles.length,
    prefilteredCount: prefilteredCandidates.length,
    insertedIdeas,
    autoQueuedJob,
  };
}

function storyTitlePreview(text: string): string {
  return text.split('\n')[0].slice(0, 60);
}
