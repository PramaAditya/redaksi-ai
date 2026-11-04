const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const moment = require('moment-timezone');

let marked;
const markedReadyPromise = import('marked').then(module => {
  marked = module.marked;
  
  Handlebars.registerHelper('markdown', function (options) {
    return new Handlebars.SafeString(marked.parse(options.fn(this)));
  });
  Handlebars.registerHelper('markdownInline', function (options) {
    return new Handlebars.SafeString(marked.parseInline(options.fn(this)));
  });
});

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID: uuidv4 } = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const s3Client = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
});

// Singleton warm Puppeteer browser pool
let sharedBrowser = null;
let browserLaunchPromise = null;

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.connected) {
    return sharedBrowser;
  }
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }
  browserLaunchPromise = puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
  }).then(browser => {
    sharedBrowser = browser;
    browserLaunchPromise = null;
    browser.on('disconnected', () => {
      if (sharedBrowser === browser) {
        sharedBrowser = null;
      }
    });
    return browser;
  }).catch(err => {
    browserLaunchPromise = null;
    throw err;
  });
  return browserLaunchPromise;
}

// 1. Original /render endpoint
app.post('/render', async (req, res) => {
  let page;
  try {
    await markedReadyPromise;
    const { viewport, html, css } = req.body;
    
    if (!html) {
      return res.status(400).json({ error: 'The "html" field is required' });
    }

    const width = parseInt(viewport?.width, 10) || 1200;
    const height = parseInt(viewport?.height, 10) || 630;

    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width, height });

    const pendingRequests = new Set();
    page.on('request', request => pendingRequests.add(request));
    page.on('requestfinished', request => pendingRequests.delete(request));
    page.on('requestfailed', request => pendingRequests.delete(request));
    const fullHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { margin: 0; padding: 0; }
          ${css || ''}
        </style>
      </head>
      <body>
        <main>
          ${html}
        </main>
      </body>
      </html>
    `.replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/textfit\/2\.4\.0\/textFit\.min\.js/g, `http://localhost:${port}/textFit.min.js`);

    try {
      await page.setContent(fullHtml, {
        waitUntil: ['networkidle0', 'load', 'domcontentloaded'],
        timeout: 15000
      });
    } catch (e) {
      console.warn('Timeout waiting for networkidle0, proceeding with screenshot anyway.');
      console.warn('Pending requests:', Array.from(pendingRequests).map(r => r.url()));
    }

    const imageBuffer = await page.screenshot({ type: 'png', omitBackground: true });

    res.setHeader('Content-Type', 'image/png');
    res.send(Buffer.from(imageBuffer));
  } catch (error) {
    console.error('Rendering error:', error);
    res.status(500).json({ error: 'Failed to render image', details: error.message });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
});

// Helper function to compile template
const compileTemplate = (templateName) => {
  let templatePath = path.join(__dirname, 'templates', `${templateName}.html`);
  if (!fs.existsSync(templatePath)) {
    // Fallback to brand-level common templates: e.g. image/poros.perjuangan/common/source_qr.html
    const parts = templateName.split('/');
    if (parts.length >= 3) {
      const mediaType = parts[0];
      const brand = parts[1];
      const fileName = parts.slice(3).join('/') || parts[parts.length - 1];
      const commonPath = path.join(__dirname, 'templates', mediaType, brand, 'common', `${fileName}.html`);
      if (fs.existsSync(commonPath)) {
        templatePath = commonPath;
      }
    }
  }
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template "${templateName}" not found.`);
  }
  let templateSource = fs.readFileSync(templatePath);
  
  // Check for UTF-16 LE BOM
  if (templateSource.length >= 2 && templateSource[0] === 0xff && templateSource[1] === 0xfe) {
    templateSource = templateSource.toString('utf16le');
  } else {
    templateSource = templateSource.toString('utf8');
  }
  
  return Handlebars.compile(templateSource);
};

// Helper to render HTML to image buffer
async function renderHtmlToBuffer(htmlContent, width, height) {
  await markedReadyPromise;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height });

    const pendingRequests = new Set();
    page.on('request', request => pendingRequests.add(request));
    page.on('requestfinished', request => pendingRequests.delete(request));
    page.on('requestfailed', request => pendingRequests.delete(request));

    try {
      await page.setContent(htmlContent, {
        waitUntil: ['networkidle0', 'load', 'domcontentloaded'],
        timeout: 15000
      });
    } catch (e) {
      console.warn('Timeout waiting for networkidle0, proceeding with screenshot anyway.');
      console.warn('Pending requests:', Array.from(pendingRequests).map(r => r.url()));
    }

    const imageBuffer = await page.screenshot({ type: 'png', omitBackground: true });
    return imageBuffer;
  } finally {
    await page.close().catch(() => {});
  }
}

// Helper to upload buffer to S3
async function uploadToS3(buffer, filename) {
  const rootFolder = process.env.S3_ROOT_FOLDER ? `${process.env.S3_ROOT_FOLDER}/` : '';
  const key = `${rootFolder}${filename}`;

  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'image/png',
  });

  await s3Client.send(command);
  
  if (process.env.S3_PUBLIC_URL_BASE) {
    // If a public URL base is provided, assume it maps directly to the bucket root
    // e.g. CDN or custom domain
    return `${process.env.S3_PUBLIC_URL_BASE}/${key}`;
  }
  
  // Fallback to endpoint + bucket name for standard path-style S3 URLs
  return `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${key}`;
}

// Unified Dynamic Endpoint
app.post('/render/:mediaType/:brand/:templateName', async (req, res) => {
  const { mediaType, brand, templateName } = req.params;
  const templateBasePath = `${mediaType}/${brand}/${templateName}`;

  try {
    await markedReadyPromise;
    const { pages, viewport } = req.body;

    if (!pages || !Array.isArray(pages)) {
      return res.status(400).json({ error: 'The "pages" array is required' });
    }

    const width = parseInt(viewport?.width, 10) || 1080;
    const height = parseInt(viewport?.height, 10) || 1350;

    const RENDER_CONCURRENCY = Math.max(1, parseInt(process.env.RENDER_CONCURRENCY || '4', 10));
    const imageUrls = new Array(pages.length);
    let nextPageIndex = 0;
    const workerCount = Math.min(RENDER_CONCURRENCY, pages.length);

    const workers = Array.from({ length: workerCount }, async () => {
      while (nextPageIndex < pages.length) {
        const i = nextPageIndex++;
        const page = pages[i];
        const templateFile = page.file;
        const context = page.context || {};

        const compiledTemplate = compileTemplate(`${templateBasePath}/${templateFile}`);
        const htmlContent = compiledTemplate(context)
          .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/textfit\/2\.4\.0\/textFit\.min\.js/g, `http://localhost:${port}/textFit.min.js`);

        const imageBuffer = await renderHtmlToBuffer(htmlContent, width, height);
        const filename = `${brand}-${templateName}-${templateFile}-${i+1}-${uuidv4()}.png`;
        imageUrls[i] = await uploadToS3(imageBuffer, filename);
      }
    });

    await Promise.all(workers);
    return res.json({ urls: imageUrls });

  } catch (error) {
    console.error(`Render Template error for ${templateBasePath}:`, error);
    return res.status(500).json({ error: 'Failed to render template', details: error.message });
  }
});

markedReadyPromise.then(() => {
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
});
