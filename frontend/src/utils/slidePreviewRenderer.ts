export interface PreviewSlideItem {
  key: string
  index: number
  label: string
  sublabel: string
  html: string
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Converts inline markdown (**bold**, *italic*) while preserving explicit <strong>, <b>, <em>, <br> tags.
 */
export function parseInlineMarkdown(raw: string | undefined | null): string {
  if (!raw) return ''
  let text = String(raw)
  // Protect allowed HTML tags
  const tags: string[] = []
  text = text.replace(/<\/?(strong|b|em|i|br|span)\b[^>]*>/gi, (match) => {
    tags.push(match)
    return `__HTML_TAG_${tags.length - 1}__`
  })
  text = escapeHtml(text)
  // **bold** -> <strong>bold</strong>
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // *italic* -> <em>italic</em>
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // Restore tags
  text = text.replace(/__HTML_TAG_(\d+)__/g, (_, idx) => tags[Number(idx)] || '')
  return text
}

/**
 * Converts block markdown paragraphs + inline bold/italic into HTML paragraphs.
 */
export function parseBlockMarkdown(raw: string | undefined | null): string {
  if (!raw) return ''
  const normalized = String(raw).replace(/\r\n/g, '\n').trim()
  if (!normalized) return ''
  const paragraphs = normalized.split(/\n{2,}/)
  return paragraphs
    .map((p) => `<p>${parseInlineMarkdown(p).replace(/\n/g, '<br/>')}</p>`)
    .join('')
}

function renderAaGeopolitikCover(data: Record<string, any>, logoUrl: string): string {
  const coverImage = data.coverImageUrl || 'https://placehold.co/1080x1350/111111/444444?text=Cover+Image'
  const titleHtml = parseInlineMarkdown(data.title || 'JUDUL UTAMA **CAROUSEL**')
  const subtitleHtml = parseInlineMarkdown(data.subtitle || '')
  const ctaText = escapeHtml(data.cta_text || 'Read More')

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Alumni+Sans:ital,wght@0,400;0,600;0,700;1,400;1,600;1,700&family=Bebas+Neue&family=Chivo+Mono:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body, html {
      width: 1080px;
      height: 1350px;
      background-color: #000000;
      color: #ffffff;
      overflow: hidden;
      position: relative;
    }
    .cover-bg {
      width: 1080px;
      height: 1350px;
      left: 0;
      top: -63px;
      position: absolute;
      object-fit: cover;
    }
    .cover-gradient {
      width: 1080px;
      height: 1042px;
      left: 0;
      top: 308px;
      position: absolute;
      background: linear-gradient(to top, #000000 0%, #000000 39%, rgba(0, 0, 0, 0) 100%);
    }
    .logo-container {
      position: absolute;
      top: 60px;
      left: 87px;
      z-index: 10;
    }
    .logo {
      max-height: 70px;
      max-width: 260px;
      object-fit: contain;
    }
    #coverContent {
      width: 906px;
      height: 680px;
      left: 87px;
      bottom: 80px;
      position: absolute;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      align-items: flex-start;
      gap: 14px;
    }
    .cover-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 128px;
      line-height: 0.94;
      color: #ffffff;
      text-shadow: 0px 0px 20px rgba(0, 0, 0, 1.0);
      width: 100%;
    }
    .cover-title strong, .cover-title b, .cover-title .highlight {
      color: #f59e0b;
      font-weight: 400;
      font-style: normal;
    }
    .cover-subtitle {
      font-family: 'Alumni Sans', sans-serif;
      font-size: 60px;
      line-height: 1.1;
      color: #ffffff;
      width: 100%;
    }
    #coverFooter {
      width: 100%;
      padding-top: 14px;
      display: flex;
      align-items: center;
      gap: 24px;
      flex-shrink: 0;
    }
    .footer-line {
      flex: 1;
      height: 4px;
      background: #ffffff;
    }
    .footer-cta {
      color: #fdba74;
      font-size: 18px;
      font-family: 'Chivo Mono', monospace;
      letter-spacing: 0.05em;
    }
  </style>
</head>
<body>
  <div style="width:1080px;height:1350px;position:relative;background:#000;overflow:hidden;">
    ${logoUrl ? `<div class="logo-container"><img src="${escapeHtml(logoUrl)}" class="logo" alt="Logo" /></div>` : ''}
    <img class="cover-bg" src="${escapeHtml(coverImage)}" alt="Cover" />
    <div class="cover-gradient"></div>
    <div id="coverContent">
      <div style="width:100%;">
        <div id="coverTitle" class="cover-title">${titleHtml}</div>
      </div>
      ${subtitleHtml ? `<div id="coverSubtitle" class="cover-subtitle">${subtitleHtml}</div>` : ''}
      <div id="coverFooter">
        <div class="footer-line"></div>
        <div class="footer-cta">${ctaText}</div>
        <svg width="80" height="24" viewBox="0 0 80 24" fill="none">
          <line x1="2" y1="12" x2="62" y2="12" stroke="white" stroke-width="3.5" stroke-linecap="round"/>
          <path d="M52 3L62 12L52 21" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M66 3L76 12L66 21" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>
  </div>
  <script>
    function binarySearchFontSize(el, maxWidth, maxHeight, minSize, maxSize, lineHeightRatio) {
      let low = minSize, high = maxSize, best = minSize;
      while (high - low >= 0.5) {
        const mid = (low + high) / 2;
        el.style.fontSize = mid + 'px';
        if (lineHeightRatio) el.style.lineHeight = String(lineHeightRatio);
        if (el.scrollHeight <= maxHeight && el.scrollWidth <= maxWidth) {
          best = mid; low = mid;
        } else {
          high = mid;
        }
      }
      el.style.fontSize = best.toFixed(1) + 'px';
    }
    function fitCoverText() {
      const container = document.getElementById('coverContent');
      const title = document.getElementById('coverTitle');
      const subtitle = document.getElementById('coverSubtitle');
      const footer = document.getElementById('coverFooter');
      if (!container || !title) return;
      const maxWidth = container.clientWidth;
      const totalHeight = container.clientHeight;
      const footerHeight = footer ? footer.offsetHeight + 14 : 50;
      let subtitleHeight = 0;
      if (subtitle) {
        binarySearchFontSize(subtitle, maxWidth, 220, 32, 60, 1.12);
        subtitleHeight = subtitle.offsetHeight + 14;
      }
      const availableTitleHeight = Math.min(400, totalHeight - footerHeight - subtitleHeight);
      binarySearchFontSize(title, maxWidth, availableTitleHeight, 72, 136, 0.94);
    }
    window.addEventListener('DOMContentLoaded', fitCoverText);
    window.addEventListener('load', fitCoverText);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitCoverText);
  </script>
</body>
</html>`
}

function renderAaGeopolitikSlide(slide: Record<string, any>, coverImage: string, logoUrl: string): string {
  if (slide.type === 'image' || (!slide.type && slide.imageUrl)) {
    const imgUrl = slide.imageUrl || coverImage || 'https://placehold.co/1080x1350/111111/444444?text=Image+Slide'
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 1080px; height: 1350px; background: #000; position: relative; overflow: hidden; }
  .main-image { width: 100%; height: 100%; object-fit: cover; position: absolute; inset: 0; }
  .watermark { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 120px; height: 120px; object-fit: contain; opacity: 0.25; }
</style></head><body>
  <img class="main-image" src="${escapeHtml(imgUrl)}" />
  ${logoUrl ? `<img class="watermark" src="${escapeHtml(logoUrl)}" />` : ''}
</body></html>`
  }

  const bgImage = slide.slide_image || coverImage || 'https://placehold.co/1080x1350/111111/444444?text=Slide+BG'
  const titleHtml = parseInlineMarkdown(slide.title || '')
  const bodyHtml = parseBlockMarkdown(slide.text || '')

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Alumni+Sans:ital,wght@0,400;0,600;0,700;1,400;1,600;1,700&family=Bebas+Neue&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body, html {
      width: 1080px;
      height: 1350px;
      background-color: #000000;
      color: #ffffff;
      overflow: hidden;
      position: relative;
    }
    .slide-bg {
      width: 1080px;
      height: 1350px;
      left: 0;
      top: -174px;
      position: absolute;
      object-fit: cover;
      opacity: 0.15;
    }
    .slide-gradient {
      width: 1080px;
      height: 810px;
      left: 0;
      top: 540px;
      position: absolute;
      background: linear-gradient(to top, #000000 0%, #000000 39%, rgba(0, 0, 0, 0) 100%);
    }
    .logo-container {
      position: absolute;
      top: 60px;
      left: 73px;
      z-index: 10;
    }
    .logo {
      max-height: 60px;
      max-width: 240px;
      object-fit: contain;
    }
    #slideContent {
      width: 934px;
      height: 700px;
      left: 73px;
      top: 569px;
      position: absolute;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: flex-start;
      gap: 20px;
    }
    .slide-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 96px;
      line-height: 0.93;
      color: #ffffff;
      text-shadow: 0px 4px 20px rgba(0, 0, 0, 0.95);
      width: 100%;
      flex-shrink: 0;
    }
    .slide-title strong, .slide-title b, .slide-title .highlight {
      color: #f59e0b;
      font-weight: 400;
      font-style: normal;
    }
    #slideBodyWrapper {
      width: 100%;
      flex: 1;
      min-height: 0;
      position: relative;
      overflow: hidden;
    }
    .slide-body {
      font-family: 'Alumni Sans', sans-serif;
      font-size: 60px;
      line-height: 1.15;
      color: #ffffff;
      width: 100%;
    }
    .slide-body strong, .slide-body b {
      font-weight: 600;
      color: #ffffff;
    }
    .slide-body p { margin: 0; }
    .slide-body p:not(:last-child) { margin-bottom: 10px; }
    .slide-body br { display: block; content: ""; margin-top: 10px; }
  </style>
</head>
<body>
  <div style="width:1080px;height:1350px;position:relative;background:#000;overflow:hidden;">
    ${logoUrl ? `<div class="logo-container"><img src="${escapeHtml(logoUrl)}" class="logo" alt="Logo" /></div>` : ''}
    <img class="slide-bg" src="${escapeHtml(bgImage)}" alt="Slide BG" />
    <div class="slide-gradient"></div>
    <div id="slideContent">
      ${titleHtml ? `<div id="slideTitle" class="slide-title">${titleHtml}</div>` : ''}
      <div id="slideBodyWrapper">
        <div id="slideBody" class="slide-body">${bodyHtml}</div>
      </div>
    </div>
  </div>
  <script>
    function binarySearchFontSize(el, maxWidth, maxHeight, minSize, maxSize, lineHeightRatio) {
      let low = minSize, high = maxSize, best = minSize;
      while (high - low >= 0.5) {
        const mid = (low + high) / 2;
        el.style.fontSize = mid + 'px';
        if (lineHeightRatio) el.style.lineHeight = String(lineHeightRatio);
        if (el.scrollHeight <= maxHeight && el.scrollWidth <= maxWidth) {
          best = mid; low = mid;
        } else {
          high = mid;
        }
      }
      el.style.fontSize = best.toFixed(1) + 'px';
    }
    function fitText() {
      const container = document.getElementById('slideContent');
      const title = document.getElementById('slideTitle');
      const bodyWrapper = document.getElementById('slideBodyWrapper');
      const body = document.getElementById('slideBody');
      if (!container || !body || !bodyWrapper) return;
      const maxWidth = container.clientWidth;
      const totalBoundaryHeight = container.clientHeight;
      if (title) {
        binarySearchFontSize(title, maxWidth, 185, 64, 104, 0.93);
      }
      const gap = 20;
      const titleHeight = title ? title.offsetHeight + gap : 0;
      const availableBodyHeight = Math.max(200, totalBoundaryHeight - titleHeight);
      bodyWrapper.style.height = availableBodyHeight + 'px';
      binarySearchFontSize(body, maxWidth, availableBodyHeight, 28, 76, 1.15);
    }
    window.addEventListener('DOMContentLoaded', fitText);
    window.addEventListener('load', fitText);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitText);
  </script>
</body>
</html>`
}

function renderPorosCover(data: Record<string, any>, logoUrl: string): string {
  const coverImage = data.coverImageUrl || 'https://placehold.co/1080x1080/111111/444444?text=Cover+Image'
  const titleHtml = parseInlineMarkdown(data.title || 'Judul Berita **Utama**')
  const effectiveLogo = logoUrl || 'https://storage.pelita.tech/logo_poros_perjuangan_white.png'

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Inter:wght@400;500;600;700;800;900&display=swap");
    body, html {
      margin: 0; padding: 0; width: 1080px; height: 1350px;
      font-family: "Inter", sans-serif; background-color: #000; color: #fff;
      overflow: hidden; position: relative;
    }
    .background-image {
      position: absolute; top: 0; left: 0; width: 100%; height: 1080px; object-fit: cover; z-index: 1;
    }
    .overlay {
      position: absolute; bottom: 0; left: 0; width: 100%; height: 90%;
      background: linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 30%, rgba(0,0,0,0.7) 55%, rgba(0,0,0,0) 100%);
      z-index: 2;
    }
    .top-bar {
      position: absolute; top: 60px; left: 60px; right: 60px;
      display: flex; justify-content: space-between; align-items: center; z-index: 3;
    }
    .logo { max-width: 250px; max-height: 80px; object-fit: contain; }
    .content { position: absolute; bottom: 120px; left: 60px; right: 60px; z-index: 3; }
    .title {
      font-family: "Instrument Serif", serif; font-size: 86px; font-weight: normal;
      line-height: 1.15; margin-bottom: 50px; letter-spacing: -1px;
      text-shadow: 0 4px 20px rgba(0, 0, 0, 0.8); width: 850px;
    }
    .title strong, .title b {
      font-style: italic; background-color: #c50202; color: #fff;
      padding: 0 0.15em; font-weight: normal;
      -webkit-box-decoration-break: clone; box-decoration-break: clone;
    }
    .progress-bar-container {
      width: 100%; height: 6px; background-color: rgba(255, 255, 255, 0.3);
      border-radius: 6px; margin-bottom: 40px; overflow: hidden;
    }
    .progress-bar { width: 100%; height: 100%; background-color: #fff; border-radius: 6px; }
    .footer-text {
      font-family: "Libre Baskerville", serif; font-size: 38px; font-style: italic;
      display: flex; align-items: center;
    }
    .footer-text span { font-family: "Inter", sans-serif; font-style: normal; margin-left: 10px; }
  </style>
</head>
<body>
  <img src="${escapeHtml(coverImage)}" class="background-image" alt="Background" />
  <div class="overlay"></div>
  <div class="top-bar"><img src="${escapeHtml(effectiveLogo)}" class="logo" alt="Logo" /></div>
  <div class="content">
    <div class="title">${titleHtml}</div>
    <div class="progress-bar-container"><div class="progress-bar"></div></div>
    <div class="footer-text">Yang kamu perlu tahu dalam 60 detik <span>&rarr;</span></div>
  </div>
</body>
</html>`
}

function renderPorosSlide(
  slide: any,
  coverImage: string,
  logoUrl: string,
  isMultiImages: boolean
): string {
  const effectiveLogo = logoUrl || 'https://storage.pelita.tech/logo_poros_perjuangan_white.png'
  if (slide && typeof slide === 'object' && (slide.type === 'image' || (!slide.type && slide.imageUrl))) {
    const imgUrl = slide.imageUrl || coverImage
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { margin: 0; width: 1080px; height: 1350px; background: #000; position: relative; overflow: hidden; }
      .img { width: 100%; height: 100%; object-fit: cover; }
      .logo { position: absolute; top: 60px; left: 60px; max-width: 250px; max-height: 80px; object-fit: contain; z-index: 2; }
    </style></head><body>
      <img class="logo" src="${escapeHtml(effectiveLogo)}" />
      <img class="img" src="${escapeHtml(imgUrl)}" />
    </body></html>`
  }

  const rawText = typeof slide === 'string' ? slide : (slide?.text || '')
  const textHtml = parseBlockMarkdown(rawText)
  const slideImage = typeof slide === 'object' ? (slide?.slide_image || '') : ''

  if (isMultiImages) {
    return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    body, html {
      margin: 0; padding: 0; width: 1080px; height: 1350px; font-family: 'Inter', sans-serif;
      background-color: #000; color: #d1d5db; overflow: hidden;
      display: flex; align-items: center; justify-content: center; position: relative;
    }
    .slide-image-container {
      position: absolute; top: 0; left: 0; width: 1080px; height: 550px; z-index: 0;
      -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 100%);
      mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 100%);
    }
    .slide-image { width: 100%; height: 100%; object-fit: cover; filter: grayscale(100%); opacity: 0.5; }
    .content {
      width: 860px; height: 600px; font-size: 42px; line-height: 1.6; margin-top: 350px;
      color: #d1d5db; z-index: 1; position: relative; display: flex; flex-direction: column; justify-content: center;
    }
    .content p { margin: 0; }
    .content p:not(:last-child) { margin-bottom: 30px; }
    .content strong, .content b { color: #fff; font-weight: 700; }
  </style>
</head>
<body>
  ${slideImage ? `<div class="slide-image-container"><img src="${escapeHtml(slideImage)}" class="slide-image" /></div>` : ''}
  <div id="slideContent" class="content">${textHtml}</div>
  <script>
    function fit() {
      const el = document.getElementById('slideContent');
      if (!el) return;
      let size = 42;
      while (size > 22 && (el.scrollHeight > 600 || el.scrollWidth > 860)) {
        size -= 1;
        el.style.fontSize = size + 'px';
      }
    }
    window.addEventListener('DOMContentLoaded', fit);
    window.addEventListener('load', fit);
  </script>
</body>
</html>`
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    body, html {
      margin: 0; padding: 0; width: 1080px; height: 1350px; font-family: 'Inter', sans-serif;
      background-color: #000; color: #d1d5db; overflow: hidden;
      display: flex; align-items: center; justify-content: center; position: relative;
    }
    .cover-image {
      position: absolute; top: 0; left: 0; width: 1080px; height: 1080px;
      object-fit: contain; filter: grayscale(100%); opacity: 0.15; z-index: 0;
    }
    .top-bar {
      position: absolute; top: 60px; left: 60px; right: 60px;
      display: flex; justify-content: space-between; align-items: center; z-index: 3;
    }
    .logo { max-width: 250px; max-height: 80px; object-fit: contain; }
    .content {
      width: 860px; height: 900px; font-size: 42px; line-height: 1.6;
      color: #d1d5db; z-index: 1; position: relative; display: flex; flex-direction: column; justify-content: center;
    }
    .content p { margin: 0; }
    .content p:not(:last-child) { margin-bottom: 30px; }
    .content strong, .content b { color: #fff; font-weight: 700; }
  </style>
</head>
<body>
  ${coverImage ? `<img src="${escapeHtml(coverImage)}" class="cover-image" />` : ''}
  <div class="top-bar"><img src="${escapeHtml(effectiveLogo)}" class="logo" /></div>
  <div id="slideContent" class="content">${textHtml}</div>
  <script>
    function fit() {
      const el = document.getElementById('slideContent');
      if (!el) return;
      let size = 42;
      while (size > 22 && (el.scrollHeight > 900 || el.scrollWidth > 860)) {
        size -= 1;
        el.style.fontSize = size + 'px';
      }
    }
    window.addEventListener('DOMContentLoaded', fit);
    window.addEventListener('load', fit);
  </script>
</body>
</html>`
}

function renderSinglePageCover(data: Record<string, any>, logoUrl: string): string {
  const coverImage = data.coverImageUrl || 'https://placehold.co/1080x1350/111111/444444?text=Cover+Image'
  const effectiveLogo = logoUrl || 'https://storage.pelita.tech/logo_poros_perjuangan_white.png'
  const titleHtml = parseInlineMarkdown(data.title || 'Judul Breaking News')
  const descHtml = parseBlockMarkdown(data.description || '')

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&family=Montserrat:wght@400;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body, html {
      width: 1080px; height: 1350px; font-family: 'Inter', sans-serif;
      background-color: #000000; color: #FFFFFF; overflow: hidden; position: relative;
    }
    .background {
      position: absolute; width: 1080px; height: 1350px; left: 0; top: 0;
      background: linear-gradient(180deg, rgba(0, 0, 0, 0.4) 0%, rgba(0, 0, 0, 0.726) 72.6%, #000000 100%), url('${escapeHtml(coverImage)}');
      background-size: cover; background-position: center; z-index: 1;
    }
    .logo-container {
      position: absolute; width: 100%; display: flex; justify-content: center; top: 132px; z-index: 2;
    }
    .logo { width: 250px; height: 77px; object-fit: contain; }
    .frame-5 {
      position: absolute; width: 888px; max-height: 680px; left: 111px; top: 500px;
      display: flex; flex-direction: column; align-items: flex-start; gap: 30px; z-index: 2;
    }
    .title {
      width: 888px; font-size: 54px; line-height: 68px; letter-spacing: -0.4px; color: #FFFFFF;
    }
    .title strong, .title b { font-weight: 700; }
    .description {
      width: 888px; font-size: 29px; line-height: 1.45; letter-spacing: -0.4px; color: #FFFFFF;
      display: flex; flex-direction: column; gap: 24px;
    }
    .description p { margin: 0; }
    .description strong, .description b { font-weight: 700; }
    .footer {
      position: absolute; width: 888px; left: 111px; top: 1219px; display: flex; align-items: center; z-index: 2;
    }
    .read-caption {
      font-family: 'Montserrat', sans-serif; font-size: 22px; color: #FFFFFF; margin-right: 23px;
    }
    .line-4 { flex-grow: 1; height: 0px; border: 2px solid #FFFFFF; }
  </style>
</head>
<body>
  <div class="background"></div>
  <div class="logo-container"><img src="${escapeHtml(effectiveLogo)}" class="logo" alt="Logo"></div>
  <div class="frame-5">
    <div class="title">${titleHtml}</div>
    <div id="descEl" class="description">${descHtml}</div>
  </div>
  <div class="footer">
    <div class="read-caption">READ CAPTION</div>
    <div class="line-4"></div>
  </div>
</body>
</html>`
}

export function buildLivePreviewSlides(
  templateId: string,
  templateData: Record<string, any> | undefined | null,
  logoUrl: string = ''
): PreviewSlideItem[] {
  const data = templateData || {}
  const isAaGeopolitik = templateId.includes('aa.geopolitik') || templateId.includes('carousel_analysis')
  const isSinglePage = templateId.includes('single_page')
  const isMultiImages = templateId.includes('carousel_multi_images')

  const items: PreviewSlideItem[] = []

  if (isSinglePage) {
    items.push({
      key: 'cover',
      index: 0,
      label: 'Cover',
      sublabel: 'Single Page Breaking News',
      html: renderSinglePageCover(data, logoUrl)
    })
    return items
  }

  // Cover slide (Index 0)
  items.push({
    key: 'cover',
    index: 0,
    label: 'Cover',
    sublabel: data.title ? String(data.title).replace(/<[^>]+>|\*\*/g, '').slice(0, 42) : 'Cover Slide',
    html: isAaGeopolitik ? renderAaGeopolitikCover(data, logoUrl) : renderPorosCover(data, logoUrl)
  })

  // Body slides (Index 1..N)
  const slides = Array.isArray(data.slides) ? data.slides : []
  const coverImage = data.coverImageUrl || ''

  slides.forEach((slide: any, idx: number) => {
    const rawHeading = typeof slide === 'object' ? (slide?.title || slide?.text || '') : String(slide || '')
    const cleanHeading = String(rawHeading).replace(/<[^>]+>|\*\*/g, '').slice(0, 42) || `Slide ${idx + 1}`

    items.push({
      key: `slide-${idx}`,
      index: idx + 1,
      label: `Slide ${idx + 1}`,
      sublabel: cleanHeading,
      html: isAaGeopolitik
        ? renderAaGeopolitikSlide(slide || {}, coverImage, logoUrl)
        : renderPorosSlide(slide, coverImage, logoUrl, isMultiImages)
    })
  })

  return items
}
