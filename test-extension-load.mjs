import { createJiti } from "jiti";
import * as url from "url";
import * as path from "path";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

const extPath = path.resolve(__dirname, "./index.ts");

const noop = () => {};

// No-op runtime/api methods shared by both mocks; spread into each object so the
// identical method list is defined once instead of copy-pasted.
const sharedNoopMethods = {
  sendMessage: noop,
  sendUserMessage: noop,
  appendEntry: noop,
  setSessionName: noop,
  getSessionName: noop,
  setLabel: noop,
  getActiveTools: noop,
  getAllTools: noop,
  setActiveTools: noop,
  getCommands: noop,
  setModel: noop,
  getThinkingLevel: noop,
  setThinkingLevel: noop,
};

const runtime = {
  pendingProviderRegistrations: [],
  registerProvider(name, config, extPath) {
    this.pendingProviderRegistrations.push({ name, config, extPath });
  },
  unregisterProvider: noop,
  assertActive: noop,
  ...sharedNoopMethods,
  refreshTools: noop,
  flagValues: new Map(),
  invalidate: noop,
};

const api = {
  on(event, handler) {
    if (event === "session_start") {
      // simulate session start
      handler({}, {});
    }
  },
  events: { on() {}, emit() {} },
  registerTool: noop,
  registerCommand: noop,
  registerShortcut: noop,
  registerFlag: noop,
  registerMessageRenderer: noop,
  getFlag: noop,
  ...sharedNoopMethods,
  exec: noop,
  registerProvider: runtime.registerProvider.bind(runtime),
  unregisterProvider: runtime.unregisterProvider.bind(runtime),
};

try {
  const factory = await jiti.import(extPath, { default: true });
  if (typeof factory !== "function") {
    console.error("Factory is not a function");
    process.exit(1);
  }
  await factory(api);
  console.log("Extension loaded successfully");
  console.log("Pending registrations:", runtime.pendingProviderRegistrations.length);
  for (const reg of runtime.pendingProviderRegistrations) {
    console.log("  Provider:", reg.name, "models:", reg.config.models?.length ?? 0);
  }
} catch (err) {
  console.error("LOAD ERROR:", err.message);
  console.error(err.stack);
}
