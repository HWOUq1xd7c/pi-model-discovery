<div align="center">

# pi-model-discovery

[![npm version](https://img.shields.io/npm/v/pi-model-discovery?style=for-the-badge)](https://www.npmjs.com/package/pi-model-discovery)
[![License](https://img.shields.io/github/license/MasuRii/pi-model-discovery?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

`pi-model-discovery` is a lightweight Pi extension and tool that discovers remote LLM provider models and **synchronizes them directly into `~/.pi/agent/models.json`**.

Pi natively loads its model list from `models.json` without requiring runtime memory interception.

</div>

## Features

- **Direct `models.json` Persistence**: Discovered models are stored directly and transparently in standard `~/.pi/agent/models.json`.
- **Simple Refresh Control**: Refresh on session start by default, or set `refreshIntervalMs` for periodic updates.
- **Zero Runtime Dependencies**: Pure Node.js built-ins with 100% self-contained ambient type declarations.
- **Multi-Protocol Discovery**: Supports OpenAI-compatible, Ollama, Anthropic-compatible, OpenAI Responses, LM Studio, llama.cpp, and static provider catalogs.
- **Provider Metadata**: Applies provider defaults and protocol-specific model metadata during synchronization.
- **Dual Triggering**: Synchronize models on-demand via the `/sync-models` slash command in Pi or the standalone `scripts/sync-models.mjs` CLI tool.

## Installation

### Pi Extension

Install through Pi's package manager:

```bash
pi install npm:pi-model-discovery
```

Or clone into your local extensions folder:

```text
~/.pi/agent/extensions/pi-model-discovery
```

## How to Initialize & Use

### 1. Configure Credentials (`~/.pi/agent/auth.json`)

Set your API keys in `~/.pi/agent/auth.json`:

```json
{
  "deepseek": { "type": "api_key", "key": "sk-your-deepseek-key" },
  "my-custom-proxy": { "type": "api_key", "key": "sk-your-proxy-key" }
}
```

*(Or set environment variables, e.g. `export DEEPSEEK_API_KEY="sk-..."`)*

### 2. Configure Providers (`~/.pi/agent/models.json`)

- **Known Built-in Providers** (DeepSeek, Groq, Mistral, Together, OpenRouter, etc.):
  `models.json` can be left empty! The discovery engine uses built-in profiles to automatically discover models and populate `models.json`.
- **Custom / Private Gateways** (OneAPI, NewAPI, vLLM, LiteLLM):
  Add a provider skeleton without models:
  ```json
  {
    "providers": {
      "my-custom-proxy": {
        "baseUrl": "https://api.myproxy.com/v1",
        "api": "openai-completions"
      }
    }
  }
  ```
- **Local Runners** (Ollama, LM Studio, Llama.cpp):
  ```json
  {
    "providers": {
      "ollama": {
        "baseUrl": "http://localhost:11434/v1",
        "api": "openai-completions",
        "apiKey": "ollama"
      }
    }
  }
  ```

### 3. Synchronize Models

The extension refreshes `models.json` on the next Pi session start by default. Configure `refreshOnStart: false` and a positive `refreshIntervalMs` when periodic refresh is preferred. Set `refreshIntervalMs` to `0` to disable periodic refresh.

#### Option A: Inside Pi
Run the slash command inside the Pi terminal:

```text
/sync-models
# Or synchronize a specific provider:
/sync-models deepseek
```

#### Option B: Standalone CLI
Run the sync script outside of Pi:

```bash
node scripts/sync-models.mjs
# Options:
node scripts/sync-models.mjs --provider my-custom-proxy
node scripts/sync-models.mjs --dry-run
```

The tool fetches models, applies provider metadata, merges them into the provider entry, and writes the updated configuration to `models.json`.

## Provider routing

Each provider uses its own `auth.json` credential and resolved `models.json` endpoint. Absolute discovery endpoints must use the provider endpoint origin.

## License

MIT © MasuRii
