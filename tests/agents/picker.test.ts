import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildGoogleNewsRssUrl,
  parseRssXml,
  resolveGoogleNewsUrl,
} from '../../src/utils/googleNewsDecoder.js';
import {
  runPickerAgent,
  cosineSimilarity,
  clusterAndDeduplicateByEmbeddings,
  uncensorText,
} from '../../src/agents/editorial/picker.js';
import { generateObject, embedMany } from 'ai';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateObject: vi.fn(),
    embedMany: vi.fn(),
  };
});

describe('News Radar: Google News RSS Builder, XML Parser & AI Picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds Google News RSS search URL with multi-word quoting and OR grouping', () => {
    const urlId = buildGoogleNewsRssUrl(['Geopolitik', 'Timur Tengah', 'BRICS'], 'id');
    expect(urlId).toContain('https://news.google.com/rss/search?q=');
    expect(decodeURIComponent(urlId)).toContain('(Geopolitik OR "Timur Tengah" OR BRICS)');
    expect(urlId).toContain('hl=id&gl=ID&ceid=ID:id');

    const urlEn = buildGoogleNewsRssUrl(['South China Sea'], 'en');
    expect(decodeURIComponent(urlEn)).toContain('"South China Sea"');
    expect(urlEn).toContain('hl=en-US&gl=US&ceid=US:en');
  });

  it('parses RSS 2.0 XML items with CDATA and HTML entities accurately', () => {
    const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <item>
            <title><![CDATA[Ketegangan Laut Merah &amp; Dampaknya ke Logistik Global]]></title>
            <link>https://news.google.com/rss/articles/CBMi12345</link>
            <pubDate>Wed, 04 Nov 2026 10:00:00 GMT</pubDate>
            <source url="https://kompas.com">Kompas.com</source>
            <description><![CDATA[<p>Kapal kargo memutar lewat Tanjung Harapan...</p>]]></description>
          </item>
          <item>
            <title>BRICS Tambah Anggota Baru di KTT Tahunan</title>
            <link>https://cnbcindonesia.com/news/brics-2026</link>
            <pubDate>Wed, 04 Nov 2026 11:00:00 GMT</pubDate>
            <source>CNBC Indonesia</source>
            <description>Ekspansi blok ekonomi negara berkembang.</description>
          </item>
        </channel>
      </rss>`;

    const parsed = parseRssXml(sampleXml);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      title: 'Ketegangan Laut Merah & Dampaknya ke Logistik Global',
      link: 'https://news.google.com/rss/articles/CBMi12345',
      pubDate: 'Wed, 04 Nov 2026 10:00:00 GMT',
      source: 'Kompas.com',
      description: 'Kapal kargo memutar lewat Tanjung Harapan...',
    });
    expect(parsed[1].source).toBe('CNBC Indonesia');
  });

  it('returns non-Google News URLs unchanged in resolveGoogleNewsUrl', async () => {
    const directUrl = 'https://www.reuters.com/world/middle-east/story-123';
    const resolved = await resolveGoogleNewsUrl(directUrl);
    expect(resolved).toBe(directUrl);
  });

  it('runs AI Chief Editor Picker with semantic deduplication & multi-source clustering', async () => {
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: {
        ranked_stories: [
          {
            title: 'Krisis Jalur Logistik Laut Merah Memicu Lonjakan Tarif Kontainer Asia-Eropa',
            links: [
              'https://kompas.com/laut-merah-1',
              'https://cnbcindonesia.com/laut-merah-2',
            ],
            pitch: 'Sudut pandang chokepoint maritim sangat relevan untuk audiens geopolitik Indonesia.',
          },
        ],
      },
    } as any);

    const candidates = [
      {
        title: 'Tarif Kontainer Naik Akibat Konflik Laut Merah',
        link: 'https://kompas.com/laut-merah-1',
        pubDate: 'Wed, 04 Nov 2026',
        source: 'Kompas',
        description: 'Biaya pengiriman naik 40%.',
      },
      {
        title: 'Krisis Laut Merah: Rute Pelayaran Asia-Eropa Terganggu',
        link: 'https://cnbcindonesia.com/laut-merah-2',
        pubDate: 'Wed, 04 Nov 2026',
        source: 'CNBC',
        description: 'Kapal memutar lewat Afrika.',
      },
    ];

    const recentTopics = ['Pemilu Paruh Waktu AS 2026'];
    const result = await runPickerAgent(
      candidates,
      recentTopics,
      'Fokus pada analisis geopolitik maritim dan rantai pasok.',
      3
    );

    expect(generateObject).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(callArgs.system).toContain('Pemilu Paruh Waktu AS 2026');
    expect(callArgs.system).toContain('Fokus pada analisis geopolitik maritim');
    expect(result).toHaveLength(1);
    expect(result[0].links).toEqual([
      'https://kompas.com/laut-merah-1',
      'https://cnbcindonesia.com/laut-merah-2',
    ]);
  });

  it('clusters similar candidate articles, hard-drops near-identical past topics (>=0.92), and flags grey-area developments', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);

    const candidates = [
      {
        title: 'Duplicate of old news',
        link: 'https://news.test/dup',
        pubDate: 'Wed',
        source: 'Media A',
        description: 'Already covered.',
      },
      {
        title: 'Laut Merah Memanas: Kompas',
        link: 'https://kompas.com/lm-1',
        pubDate: 'Wed',
        source: 'Kompas',
        description: 'Tarif kargo naik.',
      },
      {
        title: 'Krisis Laut Merah: CNBC',
        link: 'https://cnbc.com/lm-2',
        pubDate: 'Wed',
        source: 'CNBC',
        description: 'Kapal memutar lewat Afrika.',
      },
      {
        title: 'KTT BRICS 2026: Babak Baru Mata Uang',
        link: 'https://reuters.com/brics-new',
        pubDate: 'Wed',
        source: 'Reuters',
        description: 'Perkembangan baru dari KTT BRICS.',
      },
    ];

    // Candidate 0 is identical to recentTopic 0 ([1, 0, 0]) -> hard dropped!
    // Candidates 1 & 2 are very close to each other ([0, 1, 0] & [0, 0.98, 0.2]) -> merged into 1 multi-source cluster!
    // Candidate 3 is in grey area (similarity ~0.85) with recentTopic 1 ([0, 0, 1]) -> kept with grey-area warning!
    const candidateEmbeddings = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0.98, 0.198],
      [0, 0.52, 0.854],
    ];

    const recentTopics = ['Old Exact Topic', 'KTT BRICS Pekan Lalu'];
    const recentEmbeddings = [
      [1, 0, 0],
      [0, 0, 1],
    ];

    const { clusters, hardDroppedCount } = clusterAndDeduplicateByEmbeddings(
      candidates,
      candidateEmbeddings,
      recentTopics,
      recentEmbeddings
    );

    expect(hardDroppedCount).toBe(1);
    expect(clusters).toHaveLength(2);
    // First cluster should be the 2-source Laut Merah cluster (sorted by source count desc)
    expect(clusters[0].articles).toHaveLength(2);
    expect(clusters[0].articles.map((a) => a.link)).toEqual([
      'https://kompas.com/lm-1',
      'https://cnbc.com/lm-2',
    ]);
    // Second cluster has the grey-area warning
    expect(clusters[1].similarPastTopicWarning).toContain('KTT BRICS Pekan Lalu');
  });

  it('uncensors obfuscated bannedWords from historical posts before embedding & deduplication', () => {
    const rules = [
      { word: 'israel', replacement: '1srαǝl' },
      { word: 'perang', replacement: 'pǝrαng' },
      { word: 'houthi', replacement: 'Høuthı' },
    ];
    const raw = 'Donald Trump Setop Dana Tahunan Ke Rezim 1srαǝl Di Tengah Pǝrαng Lawan Høuthı';
    expect(uncensorText(raw, rules)).toBe(
      'Donald Trump Setop Dana Tahunan Ke Rezim israel Di Tengah perang Lawan houthi'
    );
  });
});
