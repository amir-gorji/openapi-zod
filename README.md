# swagger-zod-cli

Point it at an OpenAPI spec. Pick an endpoint. Get a Zod v4 schema.

```bash
node index.js --url https://petstore3.swagger.io/api/v3/openapi.json --api 6 --output ~/schemas/pet.ts
```

```ts
// ~/schemas/pet.ts
import { z } from 'zod';

export const GetPetByIdSchema = z.object({
  id: z.number().int().optional().default(null),
  name: z.string(),
  status: z.enum(["available", "pending", "sold"]).optional().default(null),
}).readonly();
```

## Install

```bash
npm install
```

## Usage

All flags are optional — omit any to be prompted interactively.

| Flag | Description |
|---|---|
| `--url <url>` | OpenAPI 3.x JSON spec URL |
| `--api <n>` | Endpoint index (shown in the list) |
| `--output <path>` | Output `.ts` file (`~` expanded) |

Running on an existing file appends new schemas and replaces same-name ones. No duplicate imports.

## What it handles

`$ref` chains · `allOf` merging · `anyOf`/`oneOf` unions · enums · nested objects & arrays · format hints (`datetime`, `uuid`, `email`, `url`) · circular refs · optional vs required fields

## Requirements

Node 18+. No Zod runtime dep — schemas are emitted as code strings.
