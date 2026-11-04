export interface RawRssArticle {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  description: string;
}

/**
 * Builds a Google News RSS search URL from an array of topic keywords and language code.
 */
export function buildGoogleNewsRssUrl(keywords: string[], language: 'id' | 'en' = 'id'): string {
  const cleaned = keywords
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k) => (k.includes(' ') ? `"${k}"` : k));

  if (cleaned.length === 0) {
    return language === 'en'
      ? 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en'
      : 'https://news.google.com/rss?hl=id&gl=ID&ceid=ID:id';
  }

  const query = cleaned.length === 1 ? cleaned[0] : `(${cleaned.join(' OR ')})`;
  const encodedQuery = encodeURIComponent(query);

  if (language === 'en') {
    return `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;
  }
  return `https://news.google.com/rss/search?q=${encodedQuery}&hl=id&gl=ID&ceid=ID:id`;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtmlTags(str: string): string {
  return decodeXmlEntities(str)
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractXmlTag(block: string, tag: string): string {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = block.match(regex);
  return match ? decodeXmlEntities(match[1].trim()) : '';
}

/**
 * Lightweight zero-dependency RSS 2.0 / Atom XML parser.
 */
export function parseRssXml(xml: string, maxItems = 30): RawRssArticle[] {
  if (!xml) return [];
  const items: RawRssArticle[] = [];
  const itemRegex = /<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
    const block = match[1];
    const rawTitle = extractXmlTag(block, 'title');
    let link = extractXmlTag(block, 'link');
    if (!link) {
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (hrefMatch) link = decodeXmlEntities(hrefMatch[1]);
    }
    const pubDate = extractXmlTag(block, 'pubDate') || extractXmlTag(block, 'published') || extractXmlTag(block, 'updated');
    const source = stripHtmlTags(extractXmlTag(block, 'source')) || 'News Feed';
    const description = stripHtmlTags(extractXmlTag(block, 'description') || extractXmlTag(block, 'summary') || '');
    const title = stripHtmlTags(rawTitle);

    if (title && link) {
      items.push({
        title,
        link: link.trim(),
        pubDate: pubDate.trim(),
        source,
        description: description.slice(0, 400),
      });
    }
  }

  return items;
}

/**
 * Fetches and parses an RSS feed URL.
 */
export async function fetchRssFeedArticles(feedUrl: string, maxItems = 30): Promise<RawRssArticle[]> {
  try {
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`RSS fetch failed with status ${response.status}`);
    }
    const xml = await response.text();
    return parseRssXml(xml, maxItems);
  } catch (err: any) {
    console.warn(`[NewsRadar] Failed to fetch RSS feed ${feedUrl}:`, err.message || err);
    return [];
  }
}

/**
 * Resolves Google News RSS redirect URLs back to their canonical publisher URLs
 * using Google's internal batchexecute RPC (`Fbv4je`), avoiding headless browsers.
 */
export async function resolveGoogleNewsUrl(sourceUrl: string): Promise<string> {
  try {
    const url = new URL(sourceUrl);
    const pathParts = url.pathname.split('/').filter((part) => part.length > 0);

    if (
      url.hostname !== 'news.google.com' ||
      pathParts.length < 2 ||
      !['articles', 'read'].includes(pathParts[pathParts.length - 2])
    ) {
      return sourceUrl;
    }

    const base64Str = pathParts[pathParts.length - 1];
    const fetchUrl = `https://news.google.com/rss/articles/${base64Str}`;

    const response = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!response.ok) {
      return sourceUrl;
    }

    const html = await response.text();
    const sgMatch = html.match(/data-n-a-sg="([^"]+)"/);
    const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);

    if (!sgMatch || !tsMatch) {
      return sourceUrl;
    }

    const signature = sgMatch[1];
    const timestamp = tsMatch[1];

    const batchUrl = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';
    const payload = [
      'Fbv4je',
      `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${base64Str}",${timestamp},"${signature}"]`,
    ];

    const reqData = `f.req=${encodeURIComponent(JSON.stringify([[payload]]))}`;

    const batchRes = await fetch(batchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      body: reqData,
      signal: AbortSignal.timeout(6000),
    });

    if (!batchRes.ok) {
      return sourceUrl;
    }

    const text = await batchRes.text();
    const splitParts = text.split('\n\n');
    if (splitParts.length < 2) {
      return sourceUrl;
    }

    const parsedData = JSON.parse(splitParts[1]);
    if (!Array.isArray(parsedData)) {
      return sourceUrl;
    }

    const batchResponses = parsedData.filter(
      (d: unknown): d is [string, string, string] =>
        Array.isArray(d) && d[0] === 'wrb.fr' && d[1] === 'Fbv4je' && typeof d[2] === 'string'
    );

    if (batchResponses.length === 0) {
      return sourceUrl;
    }

    const innerData = JSON.parse(batchResponses[0][2]);
    const decodedUrl = innerData[1];
    return typeof decodedUrl === 'string' && decodedUrl.startsWith('http') ? decodedUrl : sourceUrl;
  } catch {
    return sourceUrl;
  }
}
