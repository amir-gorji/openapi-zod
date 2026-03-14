import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import {
  isMethodKey, extractApis, resolveRef, resolveSchema,
  generateZodCode, toPascalCase, deriveSchemaName,
  extractSuccessSchema, expandPath, buildAndWrite,
} from './core.js';
import type { OpenAPISpec } from './core.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const spec = (schemas: Record<string, object> = {}): OpenAPISpec => ({
  components: { schemas: schemas as never },
});

// ── isMethodKey ───────────────────────────────────────────────────────────────

describe('isMethodKey', () => {
  it.each(['get', 'post', 'put', 'patch', 'delete'])('accepts %s', m => expect(isMethodKey(m)).toBe(true));
  it.each(['parameters', 'summary', 'x-foo'])('rejects %s', k => expect(isMethodKey(k)).toBe(false));
});

// ── extractApis ───────────────────────────────────────────────────────────────

describe('extractApis', () => {
  it('sorts paths and methods, assigns sequential index', () => {
    const s: OpenAPISpec = {
      paths: {
        '/z': { post: {}, get: {} },
        '/a': { get: {} },
      },
    };
    const apis = extractApis(s);
    expect(apis.map(a => `${a.index} ${a.method} ${a.path}`)).toEqual([
      '1 get /a',
      '2 get /z',
      '3 post /z',
    ]);
  });

  it('skips non-method keys', () => {
    const s: OpenAPISpec = { paths: { '/x': { parameters: [], get: {} } } };
    expect(extractApis(s)).toHaveLength(1);
  });
});

// ── resolveRef ────────────────────────────────────────────────────────────────

describe('resolveRef', () => {
  it('resolves internal $ref', () => {
    const s = spec({ Pet: { type: 'object' } });
    expect(resolveRef('#/components/schemas/Pet', s)).toEqual({ type: 'object' });
  });

  it('returns null for external ref', () => {
    expect(resolveRef('http://other.com/schema', spec())).toBeNull();
  });

  it('returns null for missing path', () => {
    expect(resolveRef('#/components/schemas/Missing', spec())).toBeNull();
  });
});

// ── resolveSchema ─────────────────────────────────────────────────────────────

describe('resolveSchema', () => {
  it('returns schema unchanged when no $ref', () => {
    const s = { type: 'string' };
    expect(resolveSchema(s, spec())).toBe(s);
  });

  it('resolves $ref', () => {
    const s = spec({ Str: { type: 'string' } });
    expect(resolveSchema({ $ref: '#/components/schemas/Str' }, s)).toEqual({ type: 'string' });
  });

  it('returns null on circular ref', () => {
    const s = spec({ A: { $ref: '#/components/schemas/A' } });
    expect(resolveSchema({ $ref: '#/components/schemas/A' }, s)).toBeNull();
  });
});

// ── generateZodCode ───────────────────────────────────────────────────────────

describe('generateZodCode', () => {
  const g = (schema: object) => generateZodCode(schema as never, spec());

  it.each([
    [{ type: 'string' }, 'z.string()'],
    [{ type: 'integer' }, 'z.number().int()'],
    [{ type: 'number' }, 'z.number()'],
    [{ type: 'boolean' }, 'z.boolean()'],
    [{ type: 'null' }, 'z.null()'],
    [{}, 'z.unknown()'],
  ])('primitive %o → %s', (schema, expected) => expect(g(schema)).toBe(expected));

  it.each([
    ['date-time', 'z.string().datetime({ offset: true })'],
    ['uuid', 'z.string().uuid()'],
    ['email', 'z.string().email()'],
    ['uri', 'z.string().url()'],
  ])('string format %s', (format, expected) => expect(g({ type: 'string', format })).toBe(expected));

  it('enum strings', () => expect(g({ enum: ['a', 'b'] })).toBe(`z.enum(["a", "b"])`));
  it('enum mixed → union of literals', () => expect(g({ enum: [1, 'x'] })).toBe(`z.union([z.literal(1), z.literal("x")])`));
  it('enum empty → z.never()', () => expect(g({ enum: [] })).toBe('z.never()'));

  it('array with items', () => expect(g({ type: 'array', items: { type: 'string' } })).toBe('z.array(z.string()).readonly()'));
  it('array without items', () => expect(g({ type: 'array' })).toBe('z.array(z.unknown()).readonly()'));

  it('object with required and optional fields', () => {
    const code = g({ type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id'] });
    expect(code).toContain('id: z.number().int()');
    expect(code).toContain('name: z.string().nullable().optional().default(null)');
    expect(code).toContain('.readonly()');
  });

  it('empty object → z.record', () => expect(g({ type: 'object' })).toBe('z.record(z.string(), z.unknown()).readonly()'));

  it('anyOf → z.union', () => {
    const code = g({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    expect(code).toBe('z.union([z.string(), z.number()])');
  });

  it('allOf all-objects → merged z.object', () => {
    const code = g({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] },
      ],
    });
    expect(code).toContain('a: z.string()');
    expect(code).toContain('b: z.number().int()');
  });

  it('allOf mixed → z.intersection', () => {
    const code = g({ allOf: [{ type: 'string' }, { type: 'number' }] });
    expect(code).toContain('z.intersection(');
  });

  it('multi-type array → z.union', () => {
    expect(g({ type: ['string', 'number'] })).toBe('z.union([z.string(), z.number()])');
  });

  it('$ref resolution', () => {
    const s = spec({ Pet: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } });
    expect(generateZodCode({ $ref: '#/components/schemas/Pet' }, s)).toContain('id: z.number().int()');
  });

  it('circular $ref → z.unknown comment', () => {
    const s = spec({ A: { $ref: '#/components/schemas/A' } });
    expect(generateZodCode({ $ref: '#/components/schemas/A' }, s)).toMatch(/circular ref/);
  });
});

// ── toPascalCase ──────────────────────────────────────────────────────────────

describe('toPascalCase', () => {
  it.each([
    ['foo_bar', 'FooBar'],
    ['get-pet-by-id', 'GetPetById'],
    ['alreadyCamel', 'AlreadyCamel'],
  ])('%s → %s', (input, expected) => expect(toPascalCase(input)).toBe(expected));
});

// ── deriveSchemaName ──────────────────────────────────────────────────────────

describe('deriveSchemaName', () => {
  it('uses operationId when present', () => {
    expect(deriveSchemaName({ operationId: 'getPetById' }, 'get', '/pets/{id}')).toBe('GetPetByIdSchema');
  });
  it('falls back to method + path segments', () => {
    expect(deriveSchemaName({}, 'get', '/pets/{id}')).toBe('GetPetsIdSchema');
  });
});

// ── extractSuccessSchema ──────────────────────────────────────────────────────

describe('extractSuccessSchema', () => {
  it('extracts schema from 200 application/json', () => {
    const op = {
      responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } },
    };
    expect(extractSuccessSchema(op, spec())).toEqual({ type: 'object' });
  });

  it('prefers lowest 2xx key', () => {
    const op = {
      responses: {
        '201': { content: { 'application/json': { schema: { type: 'string' } } } },
        '200': { content: { 'application/json': { schema: { type: 'number' } } } },
      },
    };
    expect(extractSuccessSchema(op, spec())).toEqual({ type: 'number' });
  });

  it('returns null when no 2xx response', () => {
    expect(extractSuccessSchema({ responses: { '400': {} } }, spec())).toBeNull();
  });

  it('returns null when no content', () => {
    expect(extractSuccessSchema({ responses: { '200': { description: 'ok' } } }, spec())).toBeNull();
  });

  it('resolves $ref response', () => {
    const s: OpenAPISpec = {
      components: {
        responses: { OkResp: { content: { 'application/json': { schema: { type: 'boolean' } } } } },
      },
    };
    const op = { responses: { '200': { $ref: '#/components/responses/OkResp' } } };
    expect(extractSuccessSchema(op, s)).toEqual({ type: 'boolean' });
  });
});

// ── expandPath ────────────────────────────────────────────────────────────────

describe('expandPath', () => {
  it('expands leading tilde', () => {
    expect(expandPath('~/foo')).toBe(`${process.env.HOME}/foo`);
  });
  it('leaves absolute path unchanged', () => {
    expect(expandPath('/abs/path')).toBe('/abs/path');
  });
});

// ── buildAndWrite ─────────────────────────────────────────────────────────────

describe('buildAndWrite', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  const mockFs = (existing?: string) => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(existing !== undefined);
    if (existing !== undefined)
      vi.spyOn(fs, 'readFileSync').mockReturnValue(existing);
    return vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  };

  it('writes new file with import + export', () => {
    const write = mockFs();
    buildAndWrite('/out/schema.ts', 'FooSchema', 'z.string()');
    const content = write.mock.calls[0][1] as string;
    expect(content).toContain(`import { z } from 'zod'`);
    expect(content).toContain('export const FooSchema = z.string();');
  });

  it('appends to existing file without duplicating import', () => {
    const write = mockFs(`import { z } from 'zod';\n\nexport const BarSchema = z.number();\n`);
    buildAndWrite('/out/schema.ts', 'FooSchema', 'z.string()');
    const content = write.mock.calls[0][1] as string;
    expect(content.match(/import \{ z \}/g)).toHaveLength(1);
    expect(content).toContain('export const FooSchema = z.string();');
    expect(content).toContain('export const BarSchema = z.number();');
  });

  it('replaces existing same-name export', () => {
    const write = mockFs(`import { z } from 'zod';\n\nexport const FooSchema = z.number();\n`);
    buildAndWrite('/out/schema.ts', 'FooSchema', 'z.string()');
    const content = write.mock.calls[0][1] as string;
    expect(content).not.toContain('z.number()');
    expect(content).toContain('export const FooSchema = z.string();');
  });
});
