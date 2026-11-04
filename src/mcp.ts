import dotenv from 'dotenv';
dotenv.config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { REDAKSI_MCP_TOOLS, getDefaultClientConfig, type RedaksiClientConfig } from './mcp/tools.js';

for (const [key, val] of Object.entries(process.env)) {
  if (typeof val === 'string' && val.includes('${')) {
    process.env[key] = val.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, varName) => process.env[varName] || '');
  }
}

export function createRedaksiMcpServer(customConfig?: RedaksiClientConfig): McpServer {
  const server = new McpServer({
    name: 'redaksi-ai',
    version: '1.0.0',
  });

  const config = customConfig || getDefaultClientConfig();

  for (const toolDef of REDAKSI_MCP_TOOLS) {
    const shape = (toolDef.schema as any)?._def?.shape
      ? typeof (toolDef.schema as any)._def.shape === 'function'
        ? (toolDef.schema as any)._def.shape()
        : (toolDef.schema as any)._def.shape
      : (toolDef.schema as any)?.shape || {};

    server.tool(
      toolDef.name,
      toolDef.description,
      shape,
      async (args: any) => {
        try {
          const parsed = toolDef.schema.parse(args || {});
          const result = await toolDef.execute(parsed, config);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Error executing ${toolDef.name}: ${message}`,
              },
            ],
          };
        }
      }
    );
  }

  return server;
}

async function main() {
  const server = createRedaksiMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Redaksi.AI MCP] Server running on stdio (23 tools registered)');
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('mcp.ts') || process.argv[1].endsWith('mcp.js'));

if (isDirectRun) {
  main().catch((err) => {
    console.error('[Redaksi.AI MCP] Fatal error:', err);
    process.exit(1);
  });
}
