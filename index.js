#!/usr/bin/env node
import { Command } from 'commander';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Node version check
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`Error: Node.js 18+ required (current: ${process.versions.node})`);
  process.exit(1);
}

const program = new Command();
program
  .option('--url <url>', 'OpenAPI JSON URL')
  .option('--api <number>', 'API index (1-based)')
  .option('--output <path>', 'Output .ts file path')
  .parse();

// ─── Section 2: Fetch & parse ─────────────────────────────────────────────────

async function fetchSpec(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Failed to fetch spec: ${e.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching spec from ${url}`);
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Response is not valid JSON: ${e.message}`);
  }
  if (json.swagger === '2.0') {
    throw new Error('Swagger 2.0 specs are not supported. Please use an OpenAPI 3.x spec.');
  }
  return json;
}

const NON_METHOD_KEYS = new Set([
  'parameters', 'summary', 'description', 'servers', 'x-*',
]);

function isMethodKey(key) {
  if (NON_METHOD_KEYS.has(key)) return false;
  if (key.startsWith('x-')) return false;
  return ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(key);
}

function extractApis(spec) {
  const apis = [];
  let index = 1;
  const paths = spec.paths ?? {};
  const sortedPaths = Object.keys(paths).sort();
  for (const p of sortedPaths) {
    const pathItem = paths[p];
    const methods = Object.keys(pathItem).filter(isMethodKey).sort();
    for (const method of methods) {
      apis.push({ index, method, path: p, operation: pathItem[method] });
      index++;
    }
  }
  return apis;
}

// ─── Section 3: $ref resolution ───────────────────────────────────────────────

function resolveRef(ref, spec) {
  if (!ref.startsWith('#/')) {
    console.warn(`Warning: external $ref "${ref}" not supported — emitting z.unknown()`);
    return null;
  }
  const parts = ref.slice(2).split('/');
  let node = spec;
  for (const part of parts) {
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || typeof node !== 'object') return null;
    node = node[decoded];
  }
  return node ?? null;
}

function resolveSchema(schema, spec, visited = new Set()) {
  if (!schema || typeof schema !== 'object') return schema;
  if (!schema.$ref) return schema;
  const ref = schema.$ref;
  if (visited.has(ref)) return null; // circular
  visited.add(ref);
  const resolved = resolveRef(ref, spec);
  if (resolved == null) return null;
  return resolveSchema(resolved, spec, visited);
}

// ─── Section 4: Zod code generator ────────────────────────────────────────────

function ind(n) {
  return ' '.repeat(n);
}

function generateObject(schema, spec, indent, visited) {
  const props = schema.properties;
  if (!props || Object.keys(props).length === 0) {
    return `z.record(z.string(), z.unknown()).readonly()`;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const lines = [];
  for (const [key, rawPropSchema] of Object.entries(props)) {
    const propSchema = resolveSchema(rawPropSchema, spec, new Set(visited));
    const effectiveSchema = propSchema ?? {};
    let expr = generateZodCode(effectiveSchema, spec, indent + 2, new Set(visited));
    const isNullable = effectiveSchema.nullable === true;
    const isOptional = !required.includes(key);
    if (isNullable) expr += '.nullable()';
    if (isOptional) expr += '.optional().default(null)';
    // Sanitize key: quote if needed
    const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    lines.push(`${ind(indent + 2)}${safeKey}: ${expr}`);
  }
  return `z.object({\n${lines.join(',\n')},\n${ind(indent)}}).readonly()`;
}

function generateArray(schema, spec, indent, visited) {
  if (!schema.items) return `z.array(z.unknown()).readonly()`;
  const inner = generateZodCode(schema.items, spec, indent, new Set(visited));
  return `z.array(${inner}).readonly()`;
}

function hasRealSchema(member) {
  if (!member || typeof member !== 'object') return false;
  const keys = Object.keys(member).filter(k => k !== 'description' && !k.startsWith('x-'));
  return keys.length > 0;
}

function generateAllOf(members, spec, indent, visited) {
  const realMembers = members.filter(hasRealSchema);
  if (realMembers.length === 0) return `z.unknown()`;

  // Resolve all members
  const resolved = realMembers.map(m => {
    const r = resolveSchema(m, spec, new Set(visited));
    return r ?? {};
  });

  // Check if all are object-like
  const allObjects = resolved.every(
    m => m.type === 'object' || m.properties != null
  );

  if (allObjects) {
    // Merge into single object
    const mergedProps = {};
    const mergedRequired = [];
    for (const m of resolved) {
      Object.assign(mergedProps, m.properties ?? {});
      if (Array.isArray(m.required)) mergedRequired.push(...m.required);
    }
    const merged = {
      type: 'object',
      properties: mergedProps,
      required: [...new Set(mergedRequired)],
    };
    return generateObject(merged, spec, indent, visited);
  }

  // Nest as z.intersection(A, z.intersection(B, C))
  const exprs = resolved.map(m => generateZodCode(m, spec, indent, new Set(visited)));
  if (exprs.length === 1) return exprs[0];
  let result = exprs[exprs.length - 1];
  for (let i = exprs.length - 2; i >= 0; i--) {
    result = `z.intersection(${exprs[i]}, ${result})`;
  }
  return result;
}

function generateUnion(members, spec, indent, visited) {
  const exprs = members.map(m => generateZodCode(m, spec, indent, new Set(visited)));
  if (exprs.length === 1) return exprs[0];
  return `z.union([${exprs.join(', ')}])`;
}

function generateZodCode(schema, spec, indent = 0, visited = new Set()) {
  if (!schema || typeof schema !== 'object') return `z.unknown()`;

  // 1. $ref
  if (schema.$ref) {
    const ref = schema.$ref;
    if (visited.has(ref)) return `z.unknown() /* circular ref: ${ref} */`;
    visited.add(ref);
    const resolved = resolveRef(ref, spec);
    if (resolved == null) return `z.unknown() /* unresolved ref: ${ref} */`;
    return generateZodCode(resolved, spec, indent, visited);
  }

  // 2. allOf
  if (Array.isArray(schema.allOf)) {
    return generateAllOf(schema.allOf, spec, indent, visited);
  }

  // 3. anyOf / oneOf
  if (Array.isArray(schema.anyOf)) {
    return generateUnion(schema.anyOf, spec, indent, visited);
  }
  if (Array.isArray(schema.oneOf)) {
    return generateUnion(schema.oneOf, spec, indent, visited);
  }

  // 4. Multi-type array (OAS 3.1)
  if (Array.isArray(schema.type)) {
    const members = schema.type.map(t => generateZodCode({ type: t }, spec, indent, visited));
    if (members.length === 1) return members[0];
    return `z.union([${members.join(', ')}])`;
  }

  // 5. enum
  if (Array.isArray(schema.enum)) {
    const vals = schema.enum;
    if (vals.length === 0) return `z.never()`;
    // All strings → z.enum
    if (vals.every(v => typeof v === 'string')) {
      return `z.enum([${vals.map(v => JSON.stringify(v)).join(', ')}])`;
    }
    // Mixed types → union of literals
    if (vals.length === 1) return `z.literal(${JSON.stringify(vals[0])})`;
    return `z.union([${vals.map(v => `z.literal(${JSON.stringify(v)})`).join(', ')}])`;
  }

  // 6. object
  if (schema.type === 'object' || schema.properties != null) {
    return generateObject(schema, spec, indent, visited);
  }

  // 7. array
  if (schema.type === 'array') {
    return generateArray(schema, spec, indent, visited);
  }

  // 8. primitives
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

  // 9. fallback
  return `z.unknown()`;
}

// ─── Schema name derivation ───────────────────────────────────────────────────

function toPascalCase(str) {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, c => c.toUpperCase());
}

function deriveSchemaName(operation, method, apiPath) {
  if (operation.operationId) {
    const cleaned = operation.operationId.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase());
    return toPascalCase(cleaned) + 'Schema';
  }
  const segments = apiPath
    .split('/')
    .filter(Boolean)
    .map(s => toPascalCase(s.replace(/[{}]/g, '')));
  return toPascalCase(method) + segments.join('') + 'Schema';
}

// ─── Success schema extraction ────────────────────────────────────────────────

function extractSuccessSchema(operation, spec) {
  const responses = operation.responses ?? {};
  const successKeys = Object.keys(responses)
    .filter(k => {
      const n = parseInt(k);
      return !isNaN(n) && n >= 200 && n < 300;
    })
    .sort((a, b) => parseInt(a) - parseInt(b));

  if (successKeys.length === 0) return null;

  let response = responses[successKeys[0]];

  // Resolve response $ref
  if (response && response.$ref) {
    response = resolveRef(response.$ref, spec);
  }

  if (!response) return null;

  // 204 or no content
  if (!response.content) {
    console.warn(`Warning: response has no content — emitting z.unknown()`);
    return null;
  }

  const schema =
    response.content?.['application/json']?.schema ??
    response.content?.['*/*']?.schema ??
    null;

  return schema;
}

// ─── Section 5: File output ───────────────────────────────────────────────────

function expandPath(p) {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function buildAndWrite(outputPath, schemaName, zodExpr) {
  const absPath = path.resolve(expandPath(outputPath));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const importLine = `import { z } from 'zod';`;
  const exportLine = `export const ${schemaName} = ${zodExpr};`;

  let content;
  if (fs.existsSync(absPath)) {
    let existing;
    try {
      existing = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      throw new Error(`Cannot read existing file at ${absPath}: ${e.message}`);
    }

    // Replace existing export with same name if present
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = program.opts();

  const url = opts.url
    ? opts.url
    : (await inquirer.prompt([{ type: 'input', name: 'url', message: 'OpenAPI JSON URL:' }])).url;

  const spec = await fetchSpec(url);
  const apis = extractApis(spec);

  if (apis.length === 0) {
    throw new Error('No API endpoints found in spec.');
  }

  console.log('\nAvailable endpoints:\n');
  apis.forEach(a =>
    console.log(`  ${a.index}. [${a.method.toUpperCase()}] ${a.path}`)
  );
  console.log();

  let apiNum;
  if (opts.api) {
    apiNum = parseInt(opts.api);
  } else {
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'n',
      message: 'Select API:',
      choices: apis.map(a => ({
        name: `[${a.method.toUpperCase()}] ${a.path}`,
        value: a.index,
      })),
      pageSize: 20,
    }]);
    apiNum = answer.n;
  }

  if (apiNum < 1 || apiNum > apis.length) {
    throw new Error(`Invalid API index ${apiNum}. Valid range: 1–${apis.length}`);
  }

  const selected = apis[apiNum - 1];
  const schema = extractSuccessSchema(selected.operation, spec);
  const zodExpr = generateZodCode(schema ?? {}, spec);
  const schemaName = deriveSchemaName(selected.operation, selected.method, selected.path);

  const outputPath = opts.output
    ? opts.output
    : (await inquirer.prompt([{
        type: 'input',
        name: 'p',
        message: 'Output .ts file path:',
      }])).p;

  buildAndWrite(outputPath, schemaName, zodExpr);
  console.log(`\n✓ Written: ${schemaName} → ${path.resolve(expandPath(outputPath))}`);
}

main().catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
