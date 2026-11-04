import { z } from 'zod';
import { generateObject, embedMany } from 'ai';
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

export interface CandidateStoryCluster {
  clusterId: number;
  articleIds: number[];
  articles: RawRssArticle[];
  centroid: number[];
  similarPastTopicWarning?: string;
}

/**
 * Computes cosine similarity between two numeric vectors in [-1, 1].
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Reverses account bannedWords obfuscation (e.g. "1srαǝl" -> "israel", "pǝrαng" -> "perang")
 * so historical post titles & captions match clean RSS headlines during embedding & LLM deduplication.
 */
export function uncensorText(
  text: string,
  bannedWords: { word: string; replacement: string }[] = []
): string {
  if (!text) return '';
  let out = text;
  for (const rule of bannedWords) {
    if (rule.replacement && rule.replacement !== '***' && rule.word) {
      const escaped = rule.replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'gi'), rule.word);
    }
  }
  return out;
}

/**
 * Stage 2A (Vector Math):
 * 1. Drops candidates with cosine similarity >= hardDedupThreshold (0.92) against recent topics.
 * 2. Flags candidates in the grey area [greyAreaThreshold (0.78), 0.92) so the LLM can judge if it's a new development vs old rehash.
 * 3. Clusters remaining articles by cosine similarity >= clusterThreshold (0.80) into multi-source story clusters.
 */
export function clusterAndDeduplicateByEmbeddings(
  candidates: RawRssArticle[],
  candidateEmbeddings: number[][],
  recentTopics: string[],
  recentTopicEmbeddings: number[][],
  options: {
    hardDedupThreshold?: number;
    greyAreaThreshold?: number;
    clusterThreshold?: number;
    maxArticlesPerCluster?: number;
  } = {}
): { clusters: CandidateStoryCluster[]; hardDroppedCount: number } {
  const hardDedupThreshold = options.hardDedupThreshold ?? 0.88;
  const greyAreaThreshold = options.greyAreaThreshold ?? 0.74;
  const clusterThreshold = options.clusterThreshold ?? 0.80;
  const maxArticlesPerCluster = options.maxArticlesPerCluster ?? 6;

  const clusters: CandidateStoryCluster[] = [];
  let hardDroppedCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const article = candidates[i];
    const vec = candidateEmbeddings[i];
    if (!vec || vec.length === 0) continue;

    // 1. Compare against historical published/rejected topics
    let maxPastSim = -1;
    let mostSimilarPastTopic = '';
    for (let j = 0; j < recentTopicEmbeddings.length; j++) {
      const pastVec = recentTopicEmbeddings[j];
      if (!pastVec || pastVec.length === 0) continue;
      const sim = cosineSimilarity(vec, pastVec);
      if (sim > maxPastSim) {
        maxPastSim = sim;
        mostSimilarPastTopic = recentTopics[j] || '';
      }
    }

    if (maxPastSim >= hardDedupThreshold) {
      hardDroppedCount++;
      continue;
    }

    const greyWarning =
      maxPastSim >= greyAreaThreshold && mostSimilarPastTopic
        ? `Mirip topik lama "${mostSimilarPastTopic}" (kemiripan=${maxPastSim.toFixed(2)}). HANYA pilih jika ini perkembangan babak baru/fakta baru!`
        : undefined;

    // 2. Find best matching existing cluster
    let bestCluster: CandidateStoryCluster | null = null;
    let bestClusterSim = -1;
    for (const cluster of clusters) {
      if (cluster.articles.length >= maxArticlesPerCluster) continue;
      const sim = cosineSimilarity(vec, cluster.centroid);
      if (sim >= clusterThreshold && sim > bestClusterSim) {
        bestClusterSim = sim;
        bestCluster = cluster;
      }
    }

    if (bestCluster) {
      const n = bestCluster.articles.length;
      bestCluster.articles.push(article);
      bestCluster.articleIds.push(i + 1);
      // Running average centroid update
      for (let d = 0; d < vec.length; d++) {
        bestCluster.centroid[d] = (bestCluster.centroid[d] * n + vec[d]) / (n + 1);
      }
      if (!bestCluster.similarPastTopicWarning && greyWarning) {
        bestCluster.similarPastTopicWarning = greyWarning;
      }
    } else {
      clusters.push({
        clusterId: clusters.length + 1,
        articleIds: [i + 1],
        articles: [article],
        centroid: [...vec],
        similarPastTopicWarning: greyWarning,
      });
    }
  }

  // Prioritize multi-source clusters (corroborated by multiple outlets), preserving recency order on ties
  clusters.sort((a, b) => b.articles.length - a.articles.length);
  clusters.forEach((c, idx) => {
    c.clusterId = idx + 1;
  });

  return { clusters, hardDroppedCount };
}

const pickerSchema = z.object({
  ranked_stories: z.array(
    z.object({
      title: z
        .string()
        .describe('Judul utama berita yang tajam, faktual, dan representatif dalam Bahasa Indonesia'),
      cluster_id: z
        .number()
        .optional()
        .describe('Nomor cluster_id dari kandidat klaster berita yang dipilih'),
      article_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Daftar nomor ID artikel kandidat (1..N) yang membahas peristiwa/isu yang SAMA (kelompokkan berita kembar ke sini)'
        ),
      links: z
        .array(z.string())
        .optional()
        .describe('Opsional: URL artikel kandidat jika tidak menggunakan article_ids'),
      pitch: z
        .string()
        .describe(
          'Penjelasan singkat 1-2 kalimat ala Kepala Redaksi mengapa isu ini sangat menarik/viral untuk audiens akun ini dan sudut pandang (angle) apa yang harus diangkat'
        ),
    })
  ),
});

function inferDefaultKeywords(connectionName: string, guidelines: string): string[] {
  const combined = `${connectionName} ${guidelines}`.toLowerCase();
  if (
    combined.includes('palestina') ||
    combined.includes('iran') ||
    combined.includes('lebanon') ||
    combined.includes('yaman') ||
    combined.includes('poros perlawanan')
  ) {
    return ['Iran', 'Palestina', 'Lebanon', 'Yaman', 'Israel', 'Timur Tengah', 'Suriah'];
  }
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

  const boundedCandidates = candidateArticles.slice(0, 60);
  const boundedRecentTopics = recentTopics.slice(0, 80);

  // Stage 2A: Attempt Gemini Embedding Clustering & Hard Deduplication (`gemini-embedding-001`)
  let clusters: CandidateStoryCluster[] | null = null;
  try {
    if (typeof embedMany === 'function' && typeof googleAI?.textEmbeddingModel === 'function') {
      const embeddingModelName = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
      const candidateTexts = boundedCandidates.map(
        (a) => `${a.title}${a.description ? ` — ${a.description.slice(0, 180)}` : ''}`
      );
      const allTextsToEmbed = [...candidateTexts, ...boundedRecentTopics];

      if (allTextsToEmbed.length > 0) {
        const { embeddings } = await embedMany({
          model: googleAI.textEmbeddingModel(embeddingModelName),
          values: allTextsToEmbed,
        });

        if (Array.isArray(embeddings) && embeddings.length === allTextsToEmbed.length) {
          const candVecs = embeddings.slice(0, boundedCandidates.length);
          const recentVecs = embeddings.slice(boundedCandidates.length);
          const clustered = clusterAndDeduplicateByEmbeddings(
            boundedCandidates,
            candVecs,
            boundedRecentTopics,
            recentVecs
          );
          console.log(
            `[NewsRadar:Embedding] Clustered ${boundedCandidates.length} articles into ${clustered.clusters.length} story cluster(s) (${clustered.hardDroppedCount} hard-dropped as duplicates).`
          );
          if (clustered.clusters.length === 0) {
            return [];
          }
          clusters = clustered.clusters;
        }
      }
    }
  } catch (embedErr: unknown) {
    const errMsg = embedErr instanceof Error ? embedErr.message : String(embedErr);
    console.warn(
      `[NewsRadar:Embedding] Embedding pre-clustering skipped (falling back to direct LLM clustering):`,
      errMsg
    );
  }

  // Fallback if embedding was skipped
  if (!clusters) {
    clusters = boundedCandidates.slice(0, 35).map((art, idx) => ({
      clusterId: idx + 1,
      articleIds: [idx + 1],
      articles: [art],
      centroid: [],
    }));
  }

  const recentListText =
    boundedRecentTopics.length > 0
      ? boundedRecentTopics.slice(0, 35).map((t, i) => `${i + 1}. ${t}`).join('\n')
      : '(Belum ada riwayat topik)';

  const systemPrompt = `Anda adalah Kepala Redaksi (Chief Editor) dan Spesialis Pertumbuhan Media Sosial Instagram di Indonesia.
Tugas Anda adalah meninjau daftar klaster berita terbaru (yang sudah dikelompokkan awal menggunakan kemiripan vektor embedding), dan memilih TOP ${maxStories} cerita terbaik yang paling berpotensi viral.

ATURAN KRITIS:
1. KESESUAIAN REDAKSI (EDITORIAL ALIGNMENT):
Saring dan urutkan berita berdasarkan karakter & pedoman redaksi akun berikut:
${editorialGuidelines ? `--- PEDOMAN REDAKSI ---\n${editorialGuidelines}\n-----------------------` : 'Berita berdampak luas, memicu diskusi publik, dan relevan bagi pembaca Indonesia.'}

2. DEDUPLIKASI SEMANTIK & EVALUASI BABAK BARU:
Di bawah ini adalah daftar topik yang SUDAH pernah dibuat atau ditolak baru-baru ini.
- Jika klaster kandidat membahas peristiwa yang SAMA PERSIS dengan riwayat di bawah, JANGAN PILIH.
- Namun jika klaster memiliki peringatan \`similar_past_topic_warning\` tetapi isinya adalah **perkembangan babak baru / fakta lanjutan yang signifikan**, Anda BOLEH memilihnya dengan menonjolkan kebaruan tersebut!
--- RIWAYAT TOPIK YANG SUDAH ADA ---
${recentListText}
------------------------------------

3. MULTI-SOURCE CLUSTERING:
Pilih berdasarkan \`cluster_id\` dan sertakan seluruh \`article_ids\` yang relevan ke dalam hasil pilihan Anda.`;

  const promptPayload = clusters.slice(0, 30).map((c) => ({
    cluster_id: c.clusterId,
    corroborated_sources_count: c.articles.length,
    article_ids: c.articleIds,
    headlines: c.articles.map((a) => `[#${boundedCandidates.indexOf(a) + 1} ${a.source}] ${a.title}`),
    primary_snippet: c.articles[0]?.description || '',
    ...(c.similarPastTopicWarning ? { similar_past_topic_warning: c.similarPastTopicWarning } : {}),
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
    prompt: `Daftar Klaster Kandidat Berita Terbaru:\n${JSON.stringify(promptPayload, null, 2)}`,
  });

  const stories: SelectedRadarStory[] = [];
  for (const item of (object.ranked_stories || []).slice(0, maxStories)) {
    const resolvedLinks: string[] = [];

    if (typeof item.cluster_id === 'number') {
      const matchedCluster = clusters.find((c) => c.clusterId === item.cluster_id);
      if (matchedCluster) {
        for (const art of matchedCluster.articles) {
          if (art.link) resolvedLinks.push(art.link);
        }
      }
    }
    if (Array.isArray(item.article_ids)) {
      for (const idNum of item.article_ids) {
        const cand = boundedCandidates[idNum - 1];
        if (cand?.link) resolvedLinks.push(cand.link);
      }
    }
    if (Array.isArray(item.links)) {
      for (const l of item.links) {
        if (l && l.startsWith('http')) resolvedLinks.push(l);
      }
    }
    if (resolvedLinks.length === 0 && boundedCandidates[0]?.link) {
      resolvedLinks.push(boundedCandidates[0].link);
    }
    stories.push({
      title: item.title,
      links: [...new Set(resolvedLinks)],
      pitch: item.pitch,
    });
  }

  return stories;
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
  const bannedWords = Array.isArray((connection as Record<string, unknown>).bannedWords)
    ? ((connection as Record<string, unknown>).bannedWords as { word: string; replacement: string }[])
    : [];

  // Stage 1: Fetch recent posts, jobs, and ideas for SQL pre-filtering & semantic deduplication
  const [recentQueue, recentJobs, recentIdeas] = await Promise.all([
    db
      .select({ text: queueTable.text, rawInput: queueTable.rawInput, templateData: queueTable.templateData })
      .from(queueTable)
      .where(sql`${queueTable.connectionId} = ${connectionId} OR ${queueTable.connectionId} IS NULL`)
      .orderBy(desc(queueTable.createdAt))
      .limit(60),
    db
      .select({ text: jobsTable.text })
      .from(jobsTable)
      .where(eq(jobsTable.connectionId, connectionId))
      .orderBy(desc(jobsTable.createdAt))
      .limit(25),
    db
      .select({ text: ideasTable.text, metadata: ideasTable.metadata })
      .from(ideasTable)
      .where(eq(ideasTable.connectionId, connectionId))
      .orderBy(desc(ideasTable.createdAt))
      .limit(40),
  ]);

  const existingTextBlob = uncensorText(
    [
      ...recentQueue.map((q) => `${q.rawInput || ''} ${q.text || ''} ${(q.templateData as Record<string, unknown>)?.title || ''}`),
      ...recentJobs.map((j) => j.text || ''),
      ...recentIdeas.map((i) => `${i.text || ''} ${(i.metadata as Record<string, unknown>)?.headline || ''}`),
    ].join('\n'),
    bannedWords
  ).toLowerCase();

  const recentTopicHeadlines: string[] = [];
  for (const q of recentQueue) {
    const rawTitle = String((q.templateData as Record<string, unknown>)?.title || '').replace(/<[^>]+>|\*\*/g, '').trim();
    const firstPara = String(q.text || '')
      .split('\n')
      .map((line) => line.replace(/<[^>]+>|\*\*/g, '').trim())
      .find((line) => line.length > 25 && line.toLowerCase() !== rawTitle.toLowerCase()) || '';

    const combinedTopic = rawTitle && firstPara
      ? `${rawTitle} — ${firstPara.slice(0, 180)}`
      : rawTitle || firstPara.slice(0, 180);

    if (combinedTopic) {
      recentTopicHeadlines.push(uncensorText(combinedTopic, bannedWords));
    }
  }
  for (const i of recentIdeas) {
    const headline = String((i.metadata as Record<string, unknown>)?.headline || i.text?.split('\n')[0] || '').trim();
    if (headline && !headline.startsWith('http')) {
      recentTopicHeadlines.push(uncensorText(headline, bannedWords));
    }
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

  // Stage 3: Resolve Google News redirect URLs in parallel across all selected stories
  const resolvedStories = await Promise.all(
    pickedStories.map(async (story, rankIdx) => {
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
      return { story, rankIdx, sourcesMeta, ideaText };
    })
  );

  const insertedIdeas = [];
  for (const item of resolvedStories) {
    const [inserted] = await db
      .insert(ideasTable)
      .values({
        connectionId,
        chatId: 'NEWS_RADAR',
        messageId: Date.now() + item.rankIdx,
        text: item.ideaText,
        media: [],
        status: 'pending',
        metadata: {
          sourceType: 'radar',
          headline: item.story.title,
          pitch: item.story.pitch,
          sources: item.sourcesMeta,
          rank: item.rankIdx + 1,
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
