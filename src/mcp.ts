import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchSpec, extractApis, generateZodCode, deriveSchemaName, extractSuccessSchema, buildAndWrite, expandPath } from './core.js';
import path from 'path';

const server = new McpServer({ name: 'openapi-zod-mcp', version: '1.0.0' });

server.tool(
  'list_endpoints',
  'Fetches an OpenAPI/Swagger JSON spec from the given URL and returns a numbered list of all API endpoints. YOU MUST call this tool first — never fetch or parse the OpenAPI JSON yourself, never read the URL contents directly. Returns one line per endpoint: "<n>. [METHOD] /path". Pass the number verbatim to generate_schema. After receiving the list, you MUST display every endpoint to the user and ask them to choose a number. Never auto-select or infer the endpoint.',
  { url: z.string().describe('URL to OpenAPI JSON spec') },
  async ({ url }) => {
    const spec = await fetchSpec(url);
    const apis = extractApis(spec);
    if (!apis.length) throw new Error('No endpoints found in spec.');
    return { content: [{ type: 'text', text: apis.map(a => `${a.index}. [${a.method.toUpperCase()}] ${a.path}`).join('\n') }] };
  }
);

server.tool(
  'generate_schema',
  'Generates a Zod TypeScript schema for a specific API endpoint and writes it directly to a file. YOU MUST use this tool — never generate Zod schemas yourself, never write TypeScript code for schemas. The file is written by this tool; do not echo or display the schema content. Returns a confirmation string on success. IMPORTANT: Only call this tool after the user has explicitly stated which endpoint number to use. Never call this based on your own inference.',
  {
    url: z.string().describe('Same OpenAPI JSON URL passed to list_endpoints'),
    api_number: z.number().int().describe('1-based endpoint number from list_endpoints'),
    output_file: z.string().describe('Absolute or ~-prefixed path to output .ts file'),
  },
  async ({ url, api_number, output_file }) => {
    const spec = await fetchSpec(url);
    const apis = extractApis(spec);
    if (api_number < 1 || api_number > apis.length)
      throw new Error(`Invalid api_number ${api_number}. Valid range: 1–${apis.length}`);
    const { operation, method, path: apiPath } = apis[api_number - 1];
    const schema = extractSuccessSchema(operation, spec);
    const zodExpr = generateZodCode(schema ?? {}, spec);
    const schemaName = deriveSchemaName(operation, method, apiPath);
    buildAndWrite(output_file, schemaName, zodExpr);
    return { content: [{ type: 'text', text: `success: wrote ${schemaName} to ${path.resolve(expandPath(output_file))}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
