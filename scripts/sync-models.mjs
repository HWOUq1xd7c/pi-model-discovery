import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distSync = resolve(extensionRoot, "dist", "src", "sync", "models-json-sync.js");

function stdout(message = "") {
  process.stdout.write(`${message}\n`);
}

function stderr(message = "") {
  process.stderr.write(`${message}\n`);
}

function usage() {
  return `Usage: node scripts/sync-models.mjs [options]

Discovers remote provider models and synchronizes them directly into ~/.pi/agent/models.json.

Options:
  --help                 Show this help text and exit.
  --dry-run              Discover models without writing to models.json.
  --provider <id>        Synchronize only the specified provider ID.
  --models-json <path>   Override the target models.json path.
  --auth-json <path>     Override the source auth.json path.
  --config <path>        Override the source config.json path.
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
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const parsed = parseFlagValue(args, index, "--provider");
      options.providerId = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--models-json" || arg.startsWith("--models-json=")) {
      const parsed = parseFlagValue(args, index, "--models-json");
      options.modelsJsonPath = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--auth-json" || arg.startsWith("--auth-json=")) {
      const parsed = parseFlagValue(args, index, "--auth-json");
      options.authJsonPath = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--config" || arg.startsWith("--config=")) {
      const parsed = parseFlagValue(args, index, "--config");
      options.configPath = parsed.value;
      index = parsed.nextIndex;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (options.help) {
    stdout(usage());
    process.exit(0);
  }

  const { syncModelsJson } = await import(pathToFileURL(distSync).href);

  stdout("Starting model discovery synchronization...");
  if (options.dryRun) {
    stdout("DRY-RUN mode active: models.json will not be modified.");
  }

  try {
    const result = await syncModelsJson({
      extensionRoot,
      ...options,
    });

    if (result.success === false) {
      stderr("Synchronization refused: models.json was not modified.");
      for (const warning of result.warnings) stderr(`  ⚠ ${warning}`);
      process.exitCode = 1;
      return;
    }

    stdout(`Target models.json: ${result.modelsJsonPath}`);
    if (result.providers.length === 0) {
      stdout("No active providers found to sync.");
      process.exit(0);
    }

    for (const p of result.providers) {
      stdout(`  - Provider '${p.providerId}': ${p.totalModels} total models (${p.addedModels} added, ${p.updatedModels} updated)`);
      for (const w of p.warnings) {
        stderr(`    ⚠ ${w}`);
      }
    }

    if (result.written) {
      stdout("Successfully wrote updated models to models.json.");
    } else if (!options.dryRun) {
      stdout("No changes needed or no models discovered.");
    }
  } catch (error) {
    stderr(`Synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
