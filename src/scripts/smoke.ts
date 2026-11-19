import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { collectResponseSchema } from '../core/contract.js';

interface SmokeCliArgs {
  engine?: string | undefined;
  allConfigured: boolean;
  prompt?: string | undefined;
  locationCode?: number | undefined;
  languageCode?: string | undefined;
  noCache: boolean;
}

function parseArgs(argv: readonly string[]): SmokeCliArgs {
  const parsed: SmokeCliArgs = {
    allConfigured: false,
    noCache: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--all-configured') {
      parsed.allConfigured = true;
      continue;
    }
    if (arg === '--no-cache') {
      parsed.noCache = true;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flag = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
    const inlineVal = eqIdx !== -1 ? arg.slice(eqIdx + 1) : undefined;

    const readValue = (): string => {
      if (inlineVal !== undefined) {
        return inlineVal;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for flag ${flag}`);
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case '--engine':
        parsed.engine = readValue().trim();
        break;
      case '--prompt':
        parsed.prompt = readValue();
        break;
      case '--location-code': {
        const rawNum = readValue();
        const num = Number(rawNum);
        if (!Number.isInteger(num) || num <= 0) {
          throw new Error(`Invalid --location-code value: "${rawNum}"`);
        }
        parsed.locationCode = num;
        break;
      }
      case '--language-code':
        parsed.languageCode = readValue().trim();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printUsage(): void {
  console.error(
    [
      'Usage:',
      '  pnpm smoke --engine=<engine> --prompt="<query>" [--location-code=2840] [--language-code=en] [--no-cache]',
      '  pnpm smoke --all-configured --prompt="<query>" [--no-cache]',
    ].join('\n'),
  );
}

async function run(): Promise<void> {
  let args: SmokeCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printUsage();
    process.exit(1);
  }

  if (args.prompt === undefined || args.prompt.trim().length === 0) {
    console.error('Error: --prompt is required.');
    printUsage();
    process.exit(1);
  }

  if (!args.allConfigured && (args.engine === undefined || args.engine.length === 0)) {
    console.error('Error: either --engine=<name> or --all-configured must be provided.');
    printUsage();
    process.exit(1);
  }

  const config = loadConfig(process.env);
  const apiKey = config.auth.gatewayApiKeys[0];
  if (apiKey === undefined) {
    console.error('Error: No GATEWAY_API_KEYS configured.');
    process.exit(1);
  }

  const app = buildApp({ config, logger: false });
  let allPassed = true;

  try {
    let targetEngines: string[];

    if (args.allConfigured) {
      const enginesRes = await app.inject({
        method: 'GET',
        url: '/v1/engines',
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });
      if (enginesRes.statusCode !== 200) {
        console.error(`Failed to query /v1/engines: HTTP ${enginesRes.statusCode}`);
        process.exit(1);
      }
      const enginesBody = enginesRes.json() as {
        engines: Array<{ engine: string; configured: boolean }>;
      };
      targetEngines = enginesBody.engines.filter((e) => e.configured).map((e) => e.engine);
      if (targetEngines.length === 0) {
        console.error('No configured engines found in current environment.');
        process.exit(1);
      }
    } else {
      targetEngines = [args.engine!];
    }

    for (const engine of targetEngines) {
      const startedAt = Date.now();
      const payload: Record<string, unknown> = {
        engine,
        prompt: args.prompt,
        ...(args.locationCode !== undefined ? { locationCode: args.locationCode } : {}),
        ...(args.languageCode !== undefined ? { languageCode: args.languageCode } : {}),
        ...(args.noCache ? { noCache: true } : {}),
      };

      const res = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...(args.noCache ? { 'x-bypass-cache': 'true' } : {}),
        },
        payload,
      });

      const elapsedMs = Date.now() - startedAt;
      console.log(`\n=== [${engine}] HTTP ${res.statusCode} (${elapsedMs}ms) ===`);

      let jsonBody: unknown;
      try {
        jsonBody = res.json();
      } catch {
        console.error('Response is not valid JSON:', res.body.slice(0, 300));
        allPassed = false;
        continue;
      }

      if (res.statusCode !== 200) {
        console.error('Error response:', JSON.stringify(jsonBody));
        console.log('GeoMix Schema: FAIL');
        allPassed = false;
        continue;
      }

      const validation = collectResponseSchema.safeParse(jsonBody);
      if (!validation.success) {
        console.error('GeoMix Schema: FAIL', validation.error.issues);
        allPassed = false;
        continue;
      }

      const data = validation.data;
      const preview = data.answerText.replace(/\s+/g, ' ').slice(0, 120);
      const topUrls = data.citations.slice(0, 3).map((c) => c.url);
      const costUsd = data.rawMeta?.['costUsd'];

      console.log(`answerText: len=${data.answerText.length} | "${preview}"`);
      console.log(`citations: count=${data.citations.length} | top3=${JSON.stringify(topUrls)}`);
      console.log(`fanOutQueries: ${JSON.stringify(data.fanOutQueries)}`);
      console.log(`costUsd: ${typeof costUsd === 'number' ? costUsd : 'n/a'}`);
      console.log('GeoMix Schema: PASS');
    }
  } finally {
    await app.close();
  }

  process.exit(allPassed ? 0 : 1);
}

run().catch((err: unknown) => {
  console.error('Smoke CLI failed:', err);
  process.exit(1);
});
