import { Command } from 'commander';
import inquirer from 'inquirer';
import path from 'path';
import { fetchSpec, extractApis, generateZodCode, deriveSchemaName, extractSuccessSchema, buildAndWrite, expandPath } from './core.js';

// Node version check
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`Error: Node.js 18+ required (current: ${process.versions.node})`);
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const program = new Command();
  program
    .option('--url <url>', 'OpenAPI JSON URL')
    .option('--api <number>', 'API index (1-based)')
    .option('--output <path>', 'Output .ts file path')
    .parse();

  const opts = program.opts<{ url?: string; api?: string; output?: string }>();

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

  let apiNum: number;
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
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
