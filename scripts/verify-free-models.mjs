import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distSrc = resolve(extensionRoot, "dist", "src");

function stdout(message = "") {
  process.stdout.write(`${message}\n`);
}

function stderr(message = "") {
  process.stderr.write(`${message}\n`);
}

async function importDistModule(relativePath) {
  return import(pathToFileURL(resolve(distSrc, relativePath)).href);
}

function usage() {
  return `Usage: node scripts/verify-free-models.mjs [options]

Verifies cached pi-model-discovery free/paid classifications with cautious provider probes.

Options:
  --help                 Show this help text and exit.
  --dry-run              Compute verification decisions without rewriting cache.json.
  --provider <id>        Verify only one cached provider ID.
  --model <id>           Verify only one model ID across matching providers.
  --concurrency <n>      Limit concurrent generation probes to a positive integer.
  --json                 Print one machine-readable JSON result to stdout.
  --strict               Exit non-zero when any model is unverifiable, or when no model is verified.
  --no-credentials       Strip API-key/auth headers from probe requests.

Credential behavior:
  By default this CLI sends configured provider credentials with verification probes so authenticated
  endpoints can be checked. Use --no-credentials to opt out; secrets are never printed in stdout,
  stderr, JSON output, cache writes, or debug logs.

Probe strategy:
  The verifier reads cache.json, checks supported OpenAI-compatible model-list endpoints first,
  then probes chat/completions only when pricing/listing metadata cannot classify a model.
`;
}

function parseFlagValue(args, index, flag) {
  const current = args[index];
  const eq = current.indexOf("=");
  if (eq !== -1) return { value: current.slice(eq + 1), nextIndex: index };
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return { value: next, nextIndex: index + 1 };
}

function parseArgs(args) {
  const options = { sendCredentials: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--no-credentials") {
      options.sendCredentials = false;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const parsed = parseFlagValue(args, index, "--provider");
      options.provider = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const parsed = parseFlagValue(args, index, "--model");
      options.model = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--concurrency" || arg.startsWith("--concurrency=")) {
      const parsed = parseFlagValue(args, index, "--concurrency");
      const concurrency = Number(parsed.value);
      if (!Number.isInteger(concurrency) || concurrency <= 0) {
        throw new Error("--concurrency must be a positive integer.");
      }
      options.concurrency = concurrency;
      index = parsed.nextIndex;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return options;
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([category, count]) => `${category}: ${count}`)
    .join(", ");
}

function printHumanSummary(result) {
  const summary = result.summary;
  stdout("Free-model verification summary");
  stdout(`  Providers checked: ${summary.providerCount}`);
  stdout(`  Models verified: ${summary.verifiedCount}`);
  stdout(`  Categories: ${formatCounts(summary.counts)}`);
  stdout(`  Cache updated: ${summary.cacheUpdated}${summary.dryRun && summary.cacheWouldUpdate ? " (dry-run preview only)" : ""}`);
  stdout(`  Duration: ${summary.durationMs}ms`);
  if (summary.verifiedCount === 0) stdout("  No matching providers or models were available to verify.");
}

async function main() {
  let cliOptions;
  try {
    cliOptions = parseArgs(process.argv.slice(2));
  } catch (error) {
    stderr(error instanceof Error ? error.message : "Invalid arguments.");
    stderr("Run with --help for usage.");
    process.exitCode = 2;
    return;
  }

  if (cliOptions.help) {
    stdout(usage().trimEnd());
    return;
  }

  const [{ CacheManager }, { loadConfigAsync }, { DebugLogger }, { verifyFreeModels }] = await Promise.all([
    importDistModule("cache/manager.js"),
    importDistModule("config/loader.js"),
    importDistModule("logging/logger.js"),
    importDistModule("verification/free-model-verifier.js"),
  ]);

  const { config, warnings } = await loadConfigAsync({ extensionRoot });
  const logger = new DebugLogger({ extensionRoot, debug: config.debug });
  for (const warning of warnings) logger.warn("free_model_verification_config_warning", { message: warning });

  try {
    if (!cliOptions.json) stdout("Starting free-model verification...");
    if (cliOptions.sendCredentials) {
      stderr("Credential notice: verification probes may send configured API-key/auth headers. Use --no-credentials to opt out.");
    }

    const result = await verifyFreeModels({
      config,
      cacheManager: new CacheManager(config.cacheFile),
      logger,
      sendCredentials: cliOptions.sendCredentials,
      dryRun: cliOptions.dryRun,
      provider: cliOptions.provider,
      model: cliOptions.model,
      concurrency: cliOptions.concurrency,
      strict: cliOptions.strict,
      json: cliOptions.json,
    });

    logger.debug("free_model_verification_script_completed", {
      verified: result.verified.length,
      cacheUpdated: result.cacheUpdated,
      durationMs: result.summary.durationMs,
      success: result.success,
    });

    if (cliOptions.json) {
      stdout(JSON.stringify(result));
    } else {
      printHumanSummary(result);
    }

    if (result.failed) {
      stderr("Strict mode failed: some models were unverifiable, or no models were verified.");
    }
    await logger.flush();
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.error("free_model_verification_script_failed", { message });
    await logger.flush();
    stderr(`Free-model verification failed: ${message}`);
    process.exitCode = 1;
  }
}

await main();
