import { TEMPLATES } from './templates.js';
import { getConnection } from './db/settings.js';
import { runResearchPhase, processMediaOnly } from './agents/editorial/research.js';
import { runOpinionPhase } from './agents/editorial/opinion.js';
import type { MediaItem, PipelineContext, ResearchResult } from './utils.js';
import { getBaseSystemPrompt, withRetry } from './utils.js';
import { isStructuredSlideScript } from './agents/pipelines/image/aa.geopolitik/carousel_analysis.js';

export async function runAutomatedPipeline(
  chatId: string,
  messageId: number,
  userInput: string,
  uploadedMedia: MediaItem[] | undefined,
  telegram: any,
  templateId: string = 'image:poros.perjuangan:carousel_dark',
  connectionId: number,
  heroStyle?: string
) {
  try {
    const template = TEMPLATES[templateId];
    if (!template) {
      throw new Error(`Template ${templateId} not found in registry`);
    }

    let statusMsg = await withRetry(() => telegram.sendMessage(chatId, '🔍 Mencari informasi...', { reply_to_message_id: messageId })) as any;

    const currentDateObj = new Date();
    const currentYear = currentDateObj.getFullYear();
    const currentDateStr = currentDateObj.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
    
    const settings = await getConnection(connectionId);
    if (!settings) throw new Error(`Connection ${connectionId} not found`);

    const baseSystemPrompt = getBaseSystemPrompt(currentDateStr, currentYear);

    const pipelineContext: PipelineContext = {
      chatId,
      messageId,
      userInput,
      uploadedMedia,
      telegram,
      statusMsg,
      settings: settings as any,
      currentDateStr,
      currentYear,
      baseSystemPrompt,
      connectionId,
      heroStyle: heroStyle || 'Dark-Dramatize',
    };

    // Phase 1: Editorial Research
    let researchResult: ResearchResult;
    
    const isDirectScript = templateId === 'image:aa.geopolitik:carousel_analysis' && isStructuredSlideScript(userInput);

    if (template.skipResearch || isDirectScript) {
      console.log(`[Pipeline] Skipping research phase for template ${templateId}${isDirectScript ? ' (Structured Slide Script detected)' : ''}`);
      researchResult = await processMediaOnly(pipelineContext);
    } else {
      researchResult = await runResearchPhase(pipelineContext);
    }

    const agentInsights: Record<string, string> = {};
    if (researchResult.researchText) {
      agentInsights.research = researchResult.researchText;
    }

    // Phase 1b: Editorial Opinion (if requested or configured)
    const requiresOpinion = template.requiredEditorialAgents?.includes('opinion') ||
      Boolean(template.slidesComposition && template.slidesComposition.opinion && template.slidesComposition.opinion > 0);

    if (!isDirectScript && requiresOpinion && researchResult.researchText) {
      console.log(`[Pipeline] Running opinion analysis agent for template ${templateId}`);
      const opinionText = await runOpinionPhase(pipelineContext, researchResult.researchText);
      if (opinionText) {
        agentInsights.opinion = opinionText;
      }
    }

    pipelineContext.agentInsights = agentInsights;

    // Phase 2-5: Template-specific Pipeline
    await template.runPipeline(pipelineContext, researchResult, agentInsights);
  } catch (error: any) {
    console.error('[Pipeline Error]', error);
    try {
      await withRetry(() => telegram.sendMessage(chatId, `❌ Terjadi kesalahan: ${error.message}`, { reply_to_message_id: messageId }));
    } catch (e) {
      console.error('[Pipeline Error] Failed to send error message to user:', e);
    }
    throw error;
  }
}
