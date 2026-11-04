import dotenv from 'dotenv';
dotenv.config();

for (const [key, val] of Object.entries(process.env)) {
  if (typeof val === 'string' && val.includes('${')) {
    process.env[key] = val.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, varName) => process.env[varName] || '');
  }
}

import { generateCarouselAnalysisContent, carouselAnalysisTemplateConfig } from '../src/agents/pipelines/image/aa.geopolitik/carousel_analysis.js';
import { getBaseSystemPrompt, PipelineContext } from '../src/utils.js';

const DEFAULT_SCRIPT = `Slide 1
Headline: Pemilu AS Baru Saja Selesai. Kenapa Kita di Indonesia Harus Peduli? 🇺🇸🇮🇩
Teks: Pemilu paruh waktu (Midterm Elections) di Amerika Serikat baru saja usai. Meski jaraknya belasan ribu kilometer dari Indonesia, hasil dari pergantian kekuasaan ini punya efek domino ke stabilitas ekonomi kita sampai ke arah perdamaian global. Mari kita bedah alasannya! ⬇️
Slide 2
Headline: Midterm Election Itu Apa Sih? 🤔
Teks: Midterm bukan ajang memilih Presiden, melainkan pemilihan anggota Kongres (DPR dan Senat AS). Ibaratnya, Presiden boleh punya visi besar, tapi Kongres yang memegang "kunci brankas" negara. Siapa pun partai yang menguasai Kongres, mereka yang menentukan ke mana arah anggaran dan hukum AS mengalir selama dua tahun ke depan.
Slide 3
Headline: Ancaman Gridlock (Pemerintahan Mandek) 🛑
Teks: Dalam politik AS, ada istilah Divided Government atau Gridlock. Ini terjadi kalau partai yang menguasai Kongres berbeda dengan partai Presiden. Efeknya? Kebijakan ekonomi dan luar negeri AS bakal jalan di tempat karena saling jegal. Kalau kebijakan AS tersendat dan lambat merespons krisis, pasar global biasanya ikut panik.
Slide 4
Headline: Efek Langsung ke Ekonomi Indonesia 💸
Teks: Kongres AS punya kuasa penuh untuk mengatur batas utang negara dan pajak mereka. Kalau Kongres membuat kebijakan yang memicu gejolak pasar atau inflasi di AS, nilai tukar Dolar bisa meroket tajam. Ujung-ujungnya, Rupiah melemah, beban utang luar negeri bengkak, dan harga barang di Indonesia ikut naik.
Slide 5
Headline: Arah Kebijakan Luar Negeri AS 🌍
Teks: Selain urusan domestik, Kongres juga yang mengetok palu untuk anggaran bantuan militer dan diplomasi luar negeri. Komposisi Kongres setelah Midterm ini menentukan apakah AS akan terus jor-joran mendanai isu keamanan global, atau justru menjadi lebih isolasionis dan hanya fokus mengurus masalah dalam negerinya sendiri.
Slide 6
Headline: Fakta Kebijakan Israel-Palestina & Faktor AIPAC 🇮🇱🇵🇸
Teks: Banyak yang bertanya apakah hasil Midterm akan mengubah drastis kebijakan AS soal Palestina. Faktanya, kemungkinan besar tidak. Mayoritas politisi dari kedua partai (Demokrat dan Republik) memiliki hubungan erat dan mendapat dukungan kuat dari AIPAC (American Israel Public Affairs Committee). Dukungan terhadap Israel telah lama menjadi konsensus lintas partai di Kongres, sehingga siapa pun yang menang, kebijakan inti bantuan militer AS kemungkinan akan tetap sama.
Slide 7
Headline: Kesimpulan: Jauh di Mata, Terasa Dampaknya 🎯
Teks: Apapun hasil akhir kursi mayoritas dari Midterm ini, dinamika politik di Kongres AS selalu menciptakan riak di panggung internasional. Perubahan arah politik mereka memaksa negara-negara berkembang seperti Indonesia untuk terus menyesuaikan strategi ekonomi dan diplomasi.
Menurut kamu, kebijakan luar negeri AS mana yang belakangan ini paling terasa dampaknya? Drop pendapatmu di komen! 👇`;

const userInput = process.env.INPUT_TEXT || DEFAULT_SCRIPT;
const connectionId = parseInt(process.env.CONNECTION_ID || '5', 10);
const shouldSaveToQueue = process.env.SAVE_TO_QUEUE === 'true';

async function main() {
  const appUrl = (process.env.APP_URL || 'https://ignewsbot.rekapancatama.com').replace(/\/$/, '');
  const password = process.env.DASHBOARD_PASSWORD || '';

  if (shouldSaveToQueue && password) {
    console.log(`[1/4] Parsing script & creating post on ${appUrl}/api/queue/from-script...`);
    const createRes = await fetch(`${appUrl}/api/queue/from-script`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${password}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        connectionId,
        templateId: carouselAnalysisTemplateConfig.id,
        text: userInput,
        generateImages: false,
        status: 'pending'
      })
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create from script (${createRes.status}): ${await createRes.text()}`);
    }

    const createData: any = await createRes.json();
    const post = createData.item;
    const postId = post.id;
    const slides: any[] = post.templateData?.slides || [];

    console.log(`      -> Created Queue Post #${postId} (1 Cover + ${slides.length} Body Slides)`);

    // 2. Generate Cover Image
    console.log(`[2/4] Generating AI Cover Image for Post #${postId}...`);
    const coverRes = await fetch(`${appUrl}/api/queue/${postId}/generate-slide-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${password}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target: 'cover',
        prompt: post.templateData?.image_prompt,
        renderMedia: false
      })
    });
    if (coverRes.ok) {
      const cData: any = await coverRes.json();
      console.log(`      -> Cover Image URL: ${cData.url}`);
    } else {
      console.warn(`      -> Cover Image warning: ${await coverRes.text()}`);
    }

    // 3. Generate Each Slide Image
    console.log(`[3/4] Generating AI Background Images for ${slides.length} Body Slides...`);
    for (let i = 0; i < slides.length; i++) {
      console.log(`      -> Generating Slide ${i + 1}/${slides.length}: "${slides[i].title}"...`);
      const sRes = await fetch(`${appUrl}/api/queue/${postId}/generate-slide-image`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${password}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          target: 'slide',
          slideIndex: i,
          prompt: slides[i].image_prompt,
          renderMedia: false
        })
      });
      if (sRes.ok) {
        const sData: any = await sRes.json();
        console.log(`         Slide ${i + 1} Image URL: ${sData.url}`);
      } else {
        console.warn(`         Slide ${i + 1} warning: ${await sRes.text()}`);
      }
    }

    // 4. Render Final 1080x1350 Carousel PNGs via Production Media Renderer
    console.log(`[4/4] Rendering final 1080x1350 PNG slides via ${appUrl}/api/queue/${postId}/regenerate-media...`);
    const renderRes = await fetch(`${appUrl}/api/queue/${postId}/regenerate-media`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${password}`,
        'Content-Type': 'application/json'
      }
    });

    if (!renderRes.ok) {
      throw new Error(`Failed to render media (${renderRes.status}): ${await renderRes.text()}`);
    }

    const renderData: any = await renderRes.json();
    console.log('\n' + '='.repeat(78));
    console.log(`>>> PRODUCTION CAROUSEL READY! (Queue Post ID: #${postId})`);
    console.log(`>>> Edit / Preview URL: ${appUrl}/post/${postId}`);
    console.log(`>>> Rendered Slides (${renderData.media?.length || 0} PNGs):`);
    (renderData.media || []).forEach((m: any, idx: number) => {
      console.log(`    [${idx === 0 ? 'COVER' : 'SLIDE ' + idx}] ${m.url}`);
    });
    console.log('='.repeat(78));
    return;
  }

  console.log('='.repeat(78));
  console.log('    TESTING AA.GEOPOLITIK CAROUSEL ANALYSIS (SCRIPT-TO-CAROUSEL PREVIEW)');
  console.log('='.repeat(78));

  const currentDateObj = new Date();
  const currentYear = currentDateObj.getFullYear();
  const currentDateStr = currentDateObj.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Jakarta'
  });
  const baseSystemPrompt = getBaseSystemPrompt(currentDateStr, currentYear);

  const context: PipelineContext = {
    chatId: 'OMP_EXTENSION',
    messageId: Date.now(),
    userInput,
    uploadedMedia: [],
    telegram: null,
    statusMsg: null,
    settings: {
      id: connectionId,
      name: 'AA Geopolitik',
      editorialGuidelines: `Fokus pada analisis geopolitik realistis: kepentingan wilayah (teritori), sumber daya alam/energi, aliansi militer, rute dagang, dan kalkulasi strategis negara-negara.`,
      bannedWords: []
    },
    currentDateStr,
    currentYear,
    baseSystemPrompt,
    connectionId,
  };

  const result = await generateCarouselAnalysisContent(context, {});

  console.log(`COVER TITLE   : ${result.title}`);
  console.log(`COVER SUBTITLE: ${result.subtitle}`);
  console.log(`COVER PROMPT  : ${result.image_prompt}`);
  result.slides.forEach((slide, idx) => {
    console.log(`\n--- BODY SLIDE ${idx + 1} ---`);
    console.log(`TITLE       : ${slide.title}`);
    console.log(`TEXT        :\n${slide.text}`);
    console.log(`IMAGE PROMPT: ${slide.image_prompt || 'N/A'}`);
  });
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
