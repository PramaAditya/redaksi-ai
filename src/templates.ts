import { PipelineContext, ResearchResult } from './utils.js';
import { runCarouselDarkPipeline, carouselDarkTemplateConfig, generateCarouselDarkMedia } from './agents/pipelines/image/poros.perjuangan/carousel_dark.js';
import { runCarouselMultiImagesPipeline, carouselMultiImagesTemplateConfig, generateCarouselMultiImagesMedia } from './agents/pipelines/image/poros.perjuangan/carousel_multi_images.js';
import { runSinglePagePipeline, singlePageTemplateConfig, generateSinglePageMedia } from './agents/pipelines/image/poros.perjuangan/single_page.js';
import { runCarouselAnalysisPipeline, carouselAnalysisTemplateConfig, generateCarouselAnalysisMedia } from './agents/pipelines/image/aa.geopolitik/carousel_analysis.js';

export type AlbumStrategy = 'first_only' | 'all_as_slides' | 'distribute_to_slides' | 'ignore';

export interface SlideTypeDefinition {
  type: string;
  label: string;
  icon?: string;
  requiredInsights?: string[];
  promptInstruction?: string;
  fields: TemplateField[];
}

export interface TemplateField {
  name: string;
  type: 'text' | 'image' | 'array' | 'string' | 'input' | string;
  label: string;
  aiContext?: string;
  itemType?: 'text' | 'object' | 'polymorphic';
  itemSchema?: TemplateField[];
  slideTypes?: SlideTypeDefinition[];
}

export interface TemplateConfig {
  id: string;
  name: string;
  description: string;
  uiSchema?: TemplateField[];
  skipResearch?: boolean;
  requiredEditorialAgents?: string[];
  slidesComposition?: Record<string, number>;
  albumStrategy?: AlbumStrategy;
  reduceTextOnAlbum?: boolean;
  runPipeline: (context: PipelineContext, research: ResearchResult, agentInsights?: Record<string, string>) => Promise<void>;
  regenerateMedia: (templateData: any, settings: any) => Promise<{ type: 'image', url: string }[]>;
}

export const TEMPLATES: Record<string, TemplateConfig> = {
  [carouselDarkTemplateConfig.id]: {
    ...carouselDarkTemplateConfig,
    runPipeline: runCarouselDarkPipeline,
    regenerateMedia: generateCarouselDarkMedia
  },
  [carouselMultiImagesTemplateConfig.id]: {
    ...carouselMultiImagesTemplateConfig,
    runPipeline: runCarouselMultiImagesPipeline,
    regenerateMedia: generateCarouselMultiImagesMedia
  },
  [singlePageTemplateConfig.id]: {
    ...singlePageTemplateConfig,
    runPipeline: runSinglePagePipeline,
    regenerateMedia: generateSinglePageMedia
  },
  [carouselAnalysisTemplateConfig.id]: {
    ...carouselAnalysisTemplateConfig,
    runPipeline: runCarouselAnalysisPipeline,
    regenerateMedia: generateCarouselAnalysisMedia
  }
};
