# openapi-zod-mcp

Point at a spec, pick an endpoint, get a correct Zod v4 schema on disk. No hallucinations.

<img src="assets/how-it-works.gif" width="600" alt="how it works">

*Recorded with a half-full context window on a large project, using a weaker model — the agent is already under pressure.*

## Why this exists

LLMs infer Zod schemas incorrectly — wrong field names, wrong nesting, subtle type bugs that only surface at runtime. This tool bypasses the model entirely for codegen: schema generation is deterministic, spec-driven, and written directly to disk. The LLM only acts as an orchestrator; it never touches the schema content.

I addressed a problem I had myself. One may find it unnecessary, and that's fair.

## Schema guarantees

- **Deterministic** — same spec + endpoint → identical output, every time. No hallucination, no typos, no missed fields.
- **Fully readonly** — all objects and arrays carry `.readonly()`. Drop straight into functional or effect-style code with no wrapping.
- **No `undefined` anywhere** — optional fields use `.nullable().optional().default(null)`. One union to handle (`T | null`), never `T | undefined | null`.
- **Blazing fast** — ~50–200ms vs 5–30s for LLM inference. Roughly 50–100× faster.
- **Token-free schema generation** — the LLM receives only a `"success: wrote …"` confirmation. A typical schema costs 200–800 output tokens to generate inline; with this tool it costs zero. For a 20-endpoint session that's 4,000–16,000 output tokens saved.

  Many users also paste the raw OpenAPI JSON directly into the chat — a common spec runs 5,000–20,000 input tokens on its own. Large JSON input *plus* large schema output can overwhelm the context window, pushing the model toward incorrect field names, wrong nesting, or missed fields. This tool eliminates both sides of that cost.

## Local Usage

Clone the repo and build:

```bash
git clone https://github.com/amir-gorji/openapi-zod-mcp.git
cd openapi-zod-mcp
npm install
npm run build
```

Then use directly via `node`:

```bash
# CLI
node dist/index.js --url https://petstore3.swagger.io/api/v3/openapi.json --api 6 --output ~/schemas/pet.ts

# MCP server (point your client at the local binary)
node dist/mcp.js
```

For MCP config, replace `"npx", "openapi-zod-mcp"` with `"node", "/absolute/path/to/openapi-zod-mcp/dist/mcp.js"`.

---

## MCP Usage (recommended)

The MCP server integrates directly with Claude Desktop, VS Code Copilot, and any MCP-compatible client. The LLM calls `list_endpoints` to browse the spec, then `generate_schema` to write the file. The schema never passes through the LLM token stream.

### Config

**VS Code (`.vscode/mcp.json` or user settings)**
```json
{
  "servers": {
    "openapi-zod-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["openapi-zod-mcp"]
    }
  }
}
```

**Claude Desktop (`claude_desktop_config.json`)**
```json
{
  "mcpServers": {
    "openapi-zod-mcp": {
      "command": "npx",
      "args": ["openapi-zod-mcp"]
    }
  }
}
```

### MCP tools

| Tool | Inputs | Returns |
|---|---|---|
| `list_endpoints` | `url` — OpenAPI JSON spec URL | Numbered list: `1. [GET] /pets` … |
| `generate_schema` | `url`, `api_number`, `output_file` | `success: wrote PetSchema to /abs/path/pet.ts` |

## CLI Usage

```bash
npx openapi-zod --url https://petstore3.swagger.io/api/v3/openapi.json --api 6 --output ~/schemas/pet.ts
```

All flags are optional — omit any to be prompted interactively.

| Flag | Description |
|---|---|
| `--url <url>` | OpenAPI 3.x JSON spec URL |
| `--api <n>` | Endpoint index (shown in the list) |
| `--output <path>` | Output `.ts` file (`~` expanded) |

Running on an existing file appends new schemas and replaces same-name ones. No duplicate imports.

## Example output

```ts
// ~/schemas/pet.ts
import { z } from 'zod';

export const GetPetByIdSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  photoUrls: z.array(z.string()).readonly(),
  category: z.object({
    id: z.number().int().nullable().optional().default(null),
    name: z.string().nullable().optional().default(null),
  }).readonly().nullable().optional().default(null),
  tags: z.array(z.object({
    id: z.number().int().nullable().optional().default(null),
    name: z.string().nullable().optional().default(null),
  }).readonly()).readonly().nullable().optional().default(null),
  status: z.enum(["available", "pending", "sold"]).nullable().optional().default(null),
}).readonly();
```

## What it handles

`$ref` chains · `allOf` merging · `anyOf`/`oneOf` unions · enums · nested objects & arrays · format hints (`datetime`, `uuid`, `email`, `url`) · circular refs

## Building

```bash
npm run build      # typecheck + minified dist/
npm run typecheck  # type-check only
```

Source is TypeScript in `src/`. Compiled output goes to `dist/`.

## Requirements

Node 18+. No Zod runtime dep — schemas are emitted as code strings.
