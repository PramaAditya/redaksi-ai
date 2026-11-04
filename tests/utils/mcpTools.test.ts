import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REDAKSI_MCP_TOOLS } from '../../src/mcp/tools.js';
import { createRedaksiMcpServer } from '../../src/mcp.js';

describe('Redaksi.AI MCP Server & 23 Tools Suite', () => {
  const mockConfig = {
    apiUrl: 'https://mock-redaksi.test',
    apiKey: 'secret-test-key',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers all 23 tools across 5 domains and initializes McpServer cleanly', () => {
    expect(REDAKSI_MCP_TOOLS).toHaveLength(23);
    const names = REDAKSI_MCP_TOOLS.map((t) => t.name);
    expect(names).toContain('redaksi_list_accounts');
    expect(names).toContain('redaksi_configure_news_radar');
    expect(names).toContain('redaksi_scan_breaking_news');
    expect(names).toContain('redaksi_create_from_script');
    expect(names).toContain('redaksi_update_post');
    expect(names).toContain('redaksi_generate_slide_image');
    expect(names).toContain('redaksi_publish_post');

    const mcpServer = createRedaksiMcpServer(mockConfig);
    expect(mcpServer).toBeDefined();
  });

  it('redaksi_configure_news_radar merges addKeywords and removeKeywords accurately', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 5,
              name: 'AA Geopolitik',
              newsRadarConfig: {
                mode: 'off',
                keywords: ['Geopolitik', 'NATO'],
                language: 'id',
                customRssUrls: [],
                intervalHours: 4,
                minPendingQueueThreshold: 2,
              },
            },
          ]),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Updated' }), { status: 200 }));

    const tool = REDAKSI_MCP_TOOLS.find((t) => t.name === 'redaksi_configure_news_radar')!;
    const res = await tool.execute(
      {
        connectionId: 5,
        mode: 'autopilot',
        addKeywords: ['Laut Merah', 'BRICS'],
        removeKeywords: ['nato'],
        minPendingQueueThreshold: 3,
      },
      mockConfig
    );

    expect(res.newsRadarConfig.mode).toBe('autopilot');
    expect(res.newsRadarConfig.keywords).toEqual(['Geopolitik', 'Laut Merah', 'BRICS']);
    expect(res.newsRadarConfig.minPendingQueueThreshold).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('redaksi_update_post patches specific slides by index, deletes/adds slides, and triggers re-render', async () => {
    const existingPost = {
      id: 601,
      text: 'Old caption',
      status: 'draft',
      templateData: {
        title: 'OLD **TITLE**',
        subtitle: 'Old subtitle',
        slides: [
          { type: 'opinion', title: 'Slide 1', text: 'Body 1', image_prompt: 'P1', slide_image: 'u1' },
          { type: 'opinion', title: 'Slide 2', text: 'Body 2', image_prompt: 'P2', slide_image: 'u2' },
          { type: 'opinion', title: 'Slide 3', text: 'Body 3', image_prompt: 'P3', slide_image: 'u3' },
        ],
      },
    };

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(existingPost), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Updated' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            media: [{ type: 'image', url: 'https://cdn.test/rendered-cover.png' }],
          }),
          { status: 200 }
        )
      );

    const tool = REDAKSI_MCP_TOOLS.find((t) => t.name === 'redaksi_update_post')!;
    const result = await tool.execute(
      {
        postId: 601,
        title: 'NEW **TITLE**',
        slideUpdates: [
          {
            slideIndex: 1,
            title: 'Slide 2 Updated',
            text: 'Body 2 Updated',
          },
        ],
        removeSlideIndices: [2],
        addSlides: [
          {
            type: 'opinion',
            title: 'Slide Baru',
            text: 'Isi slide tambahan',
          },
        ],
        renderMedia: true,
      },
      mockConfig
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.templateData.title).toBe('NEW **TITLE**');
    expect(result.templateData.slides).toHaveLength(3);
    expect(result.templateData.slides[1].title).toBe('Slide 2 Updated');
    expect(result.templateData.slides[2].title).toBe('Slide Baru');
    expect(result.media).toEqual([{ type: 'image', url: 'https://cdn.test/rendered-cover.png' }]);
  });

  it('redaksi_generate_slide_image sends multi-slide indices, style, and autoRewritePrompt to API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: 'Image(s) generated successfully',
          generatedUrlsByIndex: {
            0: 'https://cdn.test/s1-new.jpg',
            3: 'https://cdn.test/s4-new.jpg',
          },
        }),
        { status: 200 }
      )
    );

    const tool = REDAKSI_MCP_TOOLS.find((t) => t.name === 'redaksi_generate_slide_image')!;
    const parsed = tool.schema.parse({
      postId: 601,
      target: 'slides',
      slideIndices: [0, 3],
      autoRewritePrompt: true,
      style: 'realistic',
      renderMedia: true,
    });

    const result = await tool.execute(parsed, mockConfig);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mock-redaksi.test/api/queue/601/generate-slide-image',
      expect.objectContaining({
        method: 'POST',
      })
    );

    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(sentBody).toEqual({
      target: 'slides',
      slideIndices: [0, 3],
      autoRewritePrompt: true,
      style: 'realistic',
      renderMedia: true,
    });
    expect(result.generatedUrlsByIndex[3]).toBe('https://cdn.test/s4-new.jpg');
  });
});
