import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SchemaObject {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  nullable?: boolean;
  enum?: unknown[];
  allOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  format?: string;
  description?: string;
  responses?: Record<string, ResponseObject>;
  operationId?: string;
  [key: string]: unknown;
}

export interface ResponseObject {
  $ref?: string;
  content?: Record<string, { schema?: SchemaObject }>;
  description?: string;
}

export interface OperationObject {
  operationId?: string;
  responses?: Record<string, ResponseObject>;
  parameters?: unknown[];
  [key: string]: unknown;
}

export interface OpenAPISpec {
  swagger?: string;
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    responses?: Record<string, ResponseObject>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ApiEntry {
  index: number;
  method: string;
  path: string;
  operation: OperationObject;
}

export async function fetchSpec(url: string): Promise<OpenAPISpec> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Failed to fetch spec: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching spec from ${url}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Response is not valid JSON: ${(e as Error).message}`);
  }
  const spec = json as OpenAPISpec;
  if (spec.swagger === '2.0') {
    throw new Error('Swagger 2.0 specs are not supported. Please use an OpenAPI 3.x spec.');
  }
  return spec;
}

export const NON_METHOD_KEYS = new Set([
  'parameters', 'summary', 'description', 'servers', 'x-*',
]);

export function isMethodKey(key: string): boolean {
  if (NON_METHOD_KEYS.has(key)) return false;
  if (key.startsWith('x-')) return false;
  return ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(key);
}

export function extractApis(spec: OpenAPISpec): ApiEntry[] {
  const apis: ApiEntry[] = [];
  let index = 1;
  const paths = spec.paths ?? {};
  const sortedPaths = Object.keys(paths).sort();
  for (const p of sortedPaths) {
    const pathItem = paths[p];
    const methods = Object.keys(pathItem).filter(isMethodKey).sort();
    for (const method of methods) {
      apis.push({ index, method, path: p, operation: pathItem[method] as OperationObject });
      index++;
    }
  }
  return apis;
}

export function resolveRef(ref: string, spec: OpenAPISpec): SchemaObject | null {
  if (!ref.startsWith('#/')) {
    console.warn(`Warning: external $ref "${ref}" not supported — emitting z.unknown()`);
    return null;
  }
  const parts = ref.slice(2).split('/');
  let node: unknown = spec;
  for (const part of parts) {
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[decoded];
  }
  return (node ?? null) as SchemaObject | null;
}

export function resolveSchema(schema: SchemaObject, spec: OpenAPISpec, visited: Set<string> = new Set()): SchemaObject | null {
  if (!schema || typeof schema !== 'object') return schema;
  if (!schema.$ref) return schema;
  const ref = schema.$ref;
  if (visited.has(ref)) return null;
  visited.add(ref);
  const resolved = resolveRef(ref, spec);
  if (resolved == null) return null;
  return resolveSchema(resolved, spec, visited);
}

function ind(n: number): string {
  return ' '.repeat(n);
}

function generateObject(schema: SchemaObject, spec: OpenAPISpec, indent: number, visited: Set<string>): string {
  const props = schema.properties;
  if (!props || Object.keys(props).length === 0) {
    return `z.record(z.string(), z.unknown()).readonly()`;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const lines: string[] = [];
  for (const [key, rawPropSchema] of Object.entries(props)) {
    const propSchema = resolveSchema(rawPropSchema, spec, new Set(visited));
    const effectiveSchema = propSchema ?? {};
    let expr = generateZodCode(effectiveSchema, spec, indent + 2, new Set(visited));
    const isNullable = effectiveSchema.nullable === true;
    const isOptional = !required.includes(key);
    if (isNullable) expr += '.nullable()';
    if (isOptional) {
      if (!isNullable) expr += '.nullable()';
      expr += '.optional().default(null)';
    }
    const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    lines.push(`${ind(indent + 2)}${safeKey}: ${expr}`);
  }
  return `z.object({\n${lines.join(',\n')},\n${ind(indent)}}).readonly()`;
}

function generateArray(schema: SchemaObject, spec: OpenAPISpec, indent: number, visited: Set<string>): string {
  if (!schema.items) return `z.array(z.unknown()).readonly()`;
  const inner = generateZodCode(schema.items, spec, indent, new Set(visited));
  return `z.array(${inner}).readonly()`;
}

function hasRealSchema(member: SchemaObject): boolean {
  if (!member || typeof member !== 'object') return false;
  const keys = Object.keys(member).filter(k => k !== 'description' && !k.startsWith('x-'));
  return keys.length > 0;
}

function generateAllOf(members: SchemaObject[], spec: OpenAPISpec, indent: number, visited: Set<string>): string {
  const realMembers = members.filter(hasRealSchema);
  if (realMembers.length === 0) return `z.unknown()`;

  const resolved = realMembers.map(m => {
    const r = resolveSchema(m, spec, new Set(visited));
    return r ?? {};
  });

  const allObjects = resolved.every(
    m => m.type === 'object' || m.properties != null
  );

  if (allObjects) {
    const mergedProps: Record<string, SchemaObject> = {};
    const mergedRequired: string[] = [];
    for (const m of resolved) {
      Object.assign(mergedProps, m.properties ?? {});
      if (Array.isArray(m.required)) mergedRequired.push(...m.required);
    }
    const merged: SchemaObject = {
      type: 'object',
      properties: mergedProps,
      required: [...new Set(mergedRequired)],
    };
    return generateObject(merged, spec, indent, visited);
  }

  const exprs = resolved.map(m => generateZodCode(m, spec, indent, new Set(visited)));
  if (exprs.length === 1) return exprs[0];
  let result = exprs[exprs.length - 1];
  for (let i = exprs.length - 2; i >= 0; i--) {
    result = `z.intersection(${exprs[i]}, ${result})`;
  }
  return result;
}

function generateUnion(members: SchemaObject[], spec: OpenAPISpec, indent: number, visited: Set<string>): string {
  const exprs = members.map(m => generateZodCode(m, spec, indent, new Set(visited)));
  if (exprs.length === 1) return exprs[0];
  return `z.union([${exprs.join(', ')}])`;
}

export function generateZodCode(schema: SchemaObject, spec: OpenAPISpec, indent = 0, visited = new Set<string>()): string {
  if (!schema || typeof schema !== 'object') return `z.unknown()`;

  if (schema.$ref) {
    const ref = schema.$ref;
    if (visited.has(ref)) return `z.unknown() /* circular ref: ${ref} */`;
    visited.add(ref);
    const resolved = resolveRef(ref, spec);
    if (resolved == null) return `z.unknown() /* unresolved ref: ${ref} */`;
    return generateZodCode(resolved, spec, indent, visited);
  }

  if (Array.isArray(schema.allOf)) {
    return generateAllOf(schema.allOf, spec, indent, visited);
  }

  if (Array.isArray(schema.anyOf)) {
    return generateUnion(schema.anyOf, spec, indent, visited);
  }
  if (Array.isArray(schema.oneOf)) {
    return generateUnion(schema.oneOf, spec, indent, visited);
  }

  if (Array.isArray(schema.type)) {
    const members = schema.type.map(t => generateZodCode({ type: t }, spec, indent, visited));
    if (members.length === 1) return members[0];
    return `z.union([${members.join(', ')}])`;
  }

  if (Array.isArray(schema.enum)) {
    const vals = schema.enum;
    if (vals.length === 0) return `z.never()`;
    if (vals.every(v => typeof v === 'string')) {
      return `z.enum([${vals.map(v => JSON.stringify(v)).join(', ')}])`;
    }
    if (vals.length === 1) return `z.literal(${JSON.stringify(vals[0])})`;
    return `z.union([${vals.map(v => `z.literal(${JSON.stringify(v)})`).join(', ')}])`;
  }

  if (schema.type === 'object' || schema.properties != null) {
    return generateObject(schema, spec, indent, visited);
  }

  if (schema.type === 'array') {
    return generateArray(schema, spec, indent, visited);
  }

  switch (schema.type) {
    case 'string': {
      let expr = 'z.string()';
      if (schema.format === 'date-time') expr += '.datetime({ offset: true })';
      else if (schema.format === 'date') expr += ' /* date */';
      else if (schema.format === 'uuid') expr += '.uuid()';
      else if (schema.format === 'email') expr += '.email()';
      else if (schema.format === 'uri') expr += '.url()';
      return expr;
    }
    case 'integer':
      return 'z.number().int()';
    case 'number':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'null':
      return 'z.null()';
  }

  return `z.unknown()`;
}

export function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c: string) => c.toUpperCase());
}

export function deriveSchemaName(operation: OperationObject, method: string, apiPath: string): string {
  if (operation.operationId) {
    const cleaned = operation.operationId.replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase());
    return toPascalCase(cleaned) + 'Schema';
  }
  const segments = apiPath
    .split('/')
    .filter(Boolean)
    .map(s => toPascalCase(s.replace(/[{}]/g, '')));
  return toPascalCase(method) + segments.join('') + 'Schema';
}

export function extractSuccessSchema(operation: OperationObject, spec: OpenAPISpec): SchemaObject | null {
  const responses = operation.responses ?? {};
  const successKeys = Object.keys(responses)
    .filter(k => {
      const n = parseInt(k);
      return !isNaN(n) && n >= 200 && n < 300;
    })
    .sort((a, b) => parseInt(a) - parseInt(b));

  if (successKeys.length === 0) return null;

  let response: ResponseObject | null = responses[successKeys[0]];

  if (response && response.$ref) {
    response = resolveRef(response.$ref, spec) as ResponseObject | null;
  }

  if (!response) return null;

  if (!response.content) {
    console.warn(`Warning: response has no content — emitting z.unknown()`);
    return null;
  }

  const schema =
    response.content?.['application/json']?.schema ??
    response.content?.['*/*']?.schema ??
    null;

  return schema ?? null;
}

export function expandPath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function buildAndWrite(outputPath: string, schemaName: string, zodExpr: string): void {
  const absPath = path.resolve(expandPath(outputPath));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const importLine = `import { z } from 'zod';`;
  const exportLine = `export const ${schemaName} = ${zodExpr};`;

  let content: string;
  if (fs.existsSync(absPath)) {
    let existing: string;
    try {
      existing = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      throw new Error(`Cannot read existing file at ${absPath}: ${(e as Error).message}`);
    }

    const exportPattern = new RegExp(
      `export const ${schemaName} = [\\s\\S]*?;(?=\\n|$)`,
      'g'
    );
    let updated = existing;
    if (exportPattern.test(existing)) {
      updated = existing.replace(exportPattern, exportLine);
      content = updated;
    } else {
      const hasImport =
        existing.includes(`import { z } from 'zod'`) ||
        existing.includes(`import { z } from "zod"`);
      if (hasImport) {
        content = existing.trimEnd() + '\n\n' + exportLine + '\n';
      } else {
        content = importLine + '\n\n' + existing.trimEnd() + '\n\n' + exportLine + '\n';
      }
    }
  } else {
    content = importLine + '\n\n' + exportLine + '\n';
  }

  fs.writeFileSync(absPath, content, 'utf8');
}
