<div align="center">

# pi-model-discovery

[![npm version](https://img.shields.io/npm/v/pi-model-discovery?style=for-the-badge)](https://www.npmjs.com/package/pi-model-discovery)
[![License](https://img.shields.io/github/license/MasuRii/pi-model-discovery?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green?style=for-the-badge)]()

`pi-model-discovery` is a lightweight Pi coding agent extension and standalone CLI tool that discovers remote LLM provider models and **synchronizes them directly into `~/.pi/agent/models.json`**.

Pi natively loads its model list from `models.json` without requiring runtime monkey-patching or memory interception.

</div>

---

## ✨ Features

- **Direct `models.json` Synchronization**: Discovered models are cleanly formatted, deduplicated, and written directly into `~/.pi/agent/models.json` with automatic backup (`models.json.bak`).
- **20+ Built-in Provider Profiles**: Pre-configured discovery for major AI providers (DeepSeek, Groq, Mistral, NVIDIA NIM, Cerebras, Sambanova, OpenRouter, Together, HuggingFace, ZAI / Zhipu GLM, GitHub Models, Qwen, Xiaomi, Sub2API, CPA, and more).
- **Multi-Protocol Discovery**: Supports `openai-compat`, `ollama`, `anthropic-compatible`, `openai-responses`, `lm-studio`, `llama-cpp`, and `static` catalog adapters.
- **Custom Gateway & Local Runner Support**: Easily connect private proxies and gateways (OneAPI, NewAPI, vLLM, LiteLLM, Sub2API, CPA) as well as local runners (Ollama, LM Studio, llama.cpp).
- **Interactive TUI Model Catalog**: Browse, search, filter (by free/paid status, provider, cache freshness), and inspect model parameters interactively via `/pi-model-discovery`.
- **Free-Model Verification Engine**: Includes a standalone verifier CLI (`scripts/verify-free-models.mjs`) to test and validate free-tier model availability using non-destructive probes.
- **Flexible Refresh Control**: Automatically refreshes on session startup, periodically via `refreshIntervalMs`, on-demand via slash command, or using the standalone CLI script.
- **Metadata Enrichment**: Enhances discovered models with context window limits, max tokens, pricing, reasoning capabilities, and modal tags sourced from `models.dev` and `OpenRouter`.
- **Origin-Scoped Credential Isolation**: Ensures provider credentials never leak across origins, rejects cross-origin redirects, and protects secrets from stdout/stderr/logs.
- **Zero Runtime Dependencies**: Built purely with standard Node.js built-ins and self-contained ambient type declarations.

---

## 📦 Installation

### Option 1: Pi Extension Package (Recommended)

Install directly through Pi's package manager:

```bash
pi install npm:pi-model-discovery
```

### Option 2: Local Extension Clone

Clone or symlink the repository into your Pi agent extensions directory:

```bash
# macOS / Linux:
git clone https://github.com/MasuRii/pi-model-discovery.git ~/.pi/agent/extensions/pi-model-discovery

# Windows (PowerShell):
git clone https://github.com/MasuRii/pi-model-discovery.git $HOME\.pi\agent\extensions\pi-model-discovery
```

---

## 🚀 Quick Start & Usage

### 1. Configure Credentials (`~/.pi/agent/auth.json` or Env Vars)

Add your API keys to `~/.pi/agent/auth.json`:

```json
{
  "deepseek": { "type": "api_key", "key": "sk-your-deepseek-key" },
  "groq": { "type": "api_key", "key": "gsk_your-groq-key" },
  "my-custom-proxy": { "type": "api_key", "key": "sk-your-proxy-key" }
}
```

*Alternatively, use standard environment variables (e.g. `export DEEPSEEK_API_KEY="sk-..."`, `export GROQ_API_KEY="gsk_..."`). See [Built-in Provider Reference](#-built-in-provider-reference) for the full list.*

---

### 2. Configure Providers (`~/.pi/agent/models.json`)

#### A. Known Built-in Providers (Zero-Config)
If your credentials are in `auth.json` or environment variables for known providers (e.g. DeepSeek, Groq, Mistral, Together, OpenRouter, NVIDIA, Cerebras, Sambanova, ZAI, etc.), **`models.json` can be left empty!** The discovery engine will automatically resolve the endpoints, discover models, and populate `models.json`.

#### B. Custom / Private Gateways (OneAPI, NewAPI, vLLM, LiteLLM, Sub2API, CPA)
Add a provider skeleton specifying the `baseUrl` and `api` protocol:

```json
{
  "providers": {
    "my-custom-proxy": {
      "baseUrl": "https://api.myproxy.com/v1",
      "api": "openai-completions"
    },
    "sub2api": {
      "baseUrl": "http://localhost:8080",
      "api": "openai-completions"
    },
    "cpa": {
      "baseUrl": "http://127.0.0.1:8317/v1",
      "api": "openai-completions"
    }
  }
}
```

#### C. Local Model Runners (Ollama, LM Studio, llama.cpp)
Configure your local endpoint:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama"
    },
    "lm-studio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions"
    }
  }
}
```

---

### 3. Synchronize Models

The extension refreshes `models.json` on session startup by default. You can also trigger synchronization manually anytime.

#### Method A: Inside the Pi Terminal
Run the slash command inside your Pi session:

```text
# Synchronize all configured providers:
/sync-models

# Or synchronize a specific provider:
/sync-models deepseek
/sync-models my-custom-proxy
```

#### Method B: Standalone CLI
Run the standalone synchronization script outside of Pi:

```bash
# Basic sync
node scripts/sync-models.mjs

# Sync a specific provider
node scripts/sync-models.mjs --provider deepseek

# Preview changes without modifying models.json
node scripts/sync-models.mjs --dry-run

# Custom file paths
node scripts/sync-models.mjs --models-json /custom/path/models.json --auth-json /custom/path/auth.json
```

---

## 🖥️ Interactive Model Catalog TUI (`/pi-model-discovery`)

Open the built-in interactive terminal UI inside Pi to explore discovered models and metadata:

```text
/pi-model-discovery
```

### TUI Keyboard Controls:
| Key | Action |
|---|---|
| `↑` / `↓` / `PgUp` / `PgDn` | Navigate through the model list |
| `/` | Enter search / query mode (type model ID, name, provider, or tags) |
| `f` | Cycle free-tier filter (`All` → `Free` → `Paid` → `Unknown`) |
| `t` | Cycle cache freshness filter (`All` → `Fresh` → `Expired` → `Authoritative`) |
| `p` | Cycle filter by provider |
| `s` | Cycle sort key (`Provider`, `Name`, `Free`, `Context`, `Max Tokens`, `Cost`, `Fetched`) |
| `r` | Toggle sort order (ascending / descending) |
| `d` | Toggle full model details / inspection pane |
| `c` | Clear active search query and reset filters |
| `q` / `Esc` | Exit catalog modal |

---

## 🔍 Free-Model Verification Tool (`scripts/verify-free-models.mjs`)

Validate that free-tier models are currently accessible and functioning properly using non-destructive probe requests:

```bash
# Verify all cached free models
node scripts/verify-free-models.mjs

# Target a specific provider or model
node scripts/verify-free-models.mjs --provider groq
node scripts/verify-free-models.mjs --model llama-3.3-70b-versatile

# Adjust concurrency and output machine-readable JSON
node scripts/verify-free-models.mjs --concurrency 4 --json

# Strict mode (exits non-zero if any model fails verification)
node scripts/verify-free-models.mjs --strict

# Probe without sending API keys
node scripts/verify-free-models.mjs --no-credentials
```

---

## 🌐 Built-in Provider Reference

| Provider ID | Default Base URL | Protocol | Env Variables | All Free? |
|---|---|---|---|:---:|
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `openai-compat` | `NVIDIA_API_KEY`, `NVIDIA_NIM_API_KEY` | ✅ |
| `cerebras` | `https://api.cerebras.ai/v1` | `openai-compat` | `CEREBRAS_API_KEY` | ✅ |
| `groq` | `https://api.groq.com/openai/v1` | `openai-compat` | `GROQ_API_KEY` | ✅ |
| `sambanova` | `https://api.sambanova.ai/v1` | `openai-compat` | `SAMBANOVA_API_KEY` | ✅ |
| `pollinations` | `https://gen.pollinations.ai/v1` | `openai-compat` | `POLLINATIONS_API_KEY` | ✅ |
| `llm7` | `https://api.llm7.io/v1` | `openai-compat` | `LLM7_API_KEY` | ✅ |
| `zai` *(Zhipu GLM)* | `https://open.bigmodel.cn/api/paas/v4` | `openai-compat` | `ZAI_API_KEY`, `ZHIPU_API_KEY` | ✅ *(Flash)* |
| `deepseek` | `https://api.deepseek.com/v1` | `openai-compat` | `DEEPSEEK_API_KEY` | ❌ |
| `mistral` | `https://api.mistral.ai/v1` | `openai-compat` | `MISTRAL_API_KEY` | ❌ |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai-compat` | `OPENROUTER_API_KEY` | Free filter |
| `together` | `https://api.together.xyz/v1` | `openai-compat` | `TOGETHER_API_KEY`, `TOGETHER_AI_API_KEY` | ❌ |
| `huggingface` | `https://router.huggingface.co/v1` | `openai-compat` | `HF_TOKEN`, `HUGGINGFACE_API_KEY` | ❌ |
| `github-models` | `https://models.inference.ai.azure.com` | `openai-compat` | `GH_MODELS_TOKEN`, `GITHUB_TOKEN` | ❌ |
| `qwen` | `https://portal.qwen.ai/v1` | `openai-compat` | `QWEN_API_KEY`, `DASHSCOPE_API_KEY` | ❌ |
| `xiaomi` | `https://api.xiaomimimo.com/anthropic` | `openai-compat` | `XIAOMI_API_KEY` | ❌ |
| `xiaomi-token-plan-cn` | `https://token-plan-cn.xiaomimimo.com/anthropic` | `openai-compat` | `XIAOMI_API_KEY` | ❌ |
| `xiaomi-token-plan-ams` | `https://token-plan-ams.xiaomimimo.com/anthropic` | `openai-compat` | `XIAOMI_API_KEY` | ❌ |
| `xiaomi-token-plan-sgp` | `https://token-plan-sgp.xiaomimimo.com/anthropic` | `openai-compat` | `XIAOMI_API_KEY` | ❌ |
| `novita` | `https://api.novita.ai/openai/v1` | `openai-compat` | `NOVITA_API_KEY` | ❌ |
| `deepinfra` | `https://api.deepinfra.com/v1/openai` | `openai-compat` | `DEEPINFRA_API_KEY` | ❌ |
| `kluster` | `https://api.kluster.ai/v1` | `openai-compat` | `KLUSTER_API_KEY` | ❌ |
| `cline` | `https://api.cline.bot/api/v1` | `openai-compat` | `CLINE_API_KEY` | ❌ |
| `kilo` | `https://api.kilo.ai/api/gateway` | `openai-compat` | `KILO_API_KEY` | ❌ |
| `sub2api` | `http://localhost:8080` | `openai-compat` | `SUB2API_KEY` | Public / Key |
| `cpa` | `http://127.0.0.1:8317/v1` | `openai-compat` | `CPA_API_KEY` | Public / Key |
| `cloudflare` | Resolved per account | `openai-compat` | `CLOUDFLARE_API_KEY` | ❌ |

---

## ⚙️ Advanced Configuration (`config.json`)

To customize extension behaviors, create or edit `config.json` in the extension root (see `config/config.example.json` for reference):

```json
{
  "enabled": true,
  "debug": false,
  "refreshOnStart": true,
  "refreshIntervalMs": 0,
  "autoImport": {
    "enabled": true,
    "includeProviders": [],
    "excludeProviders": [],
    "discovery": {
      "enabled": true,
      "timeoutMs": 10000,
      "typeByProvider": {
        "custom-anthropic": "anthropic-compatible",
        "custom-ollama": "ollama"
      },
      "endpointPathByProvider": {
        "my-gateway": "/v1/models"
      }
    }
  },
  "providers": [
    {
      "id": "my-custom-proxy",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKey": "${MYPROXY_API_KEY}",
      "api": "openai-completions",
      "discovery": {
        "type": "openai-compat",
        "enabled": true,
        "timeoutMs": 10000,
        "allowModels": [],
        "blockModels": ["embed", "rerank", "tts"],
        "pagination": {
          "enabled": false
        }
      },
      "defaults": {
        "contextWindow": 128000,
        "maxTokens": 16384,
        "cost": {
          "input": 0,
          "output": 0
        },
        "input": ["text", "image"],
        "reasoning": true
      }
    }
  ]
}
```

### Configuration Options:
- **`enabled`** *(boolean, default: `true`)*: Master toggle for the extension.
- **`debug`** *(boolean, default: `false`)*: Enables verbose logging to `debug/model-discovery.log`.
- **`refreshOnStart`** *(boolean, default: `true`)*: Automatically trigger model synchronization when Pi starts a session.
- **`refreshIntervalMs`** *(number, default: `0`)*: Periodic background synchronization interval in milliseconds (`0` disables periodic sync).
- **`autoImport.includeProviders` / `excludeProviders`** *(string[])*: Whitelist or blacklist provider IDs for automatic discovery.
- **`autoImport.discovery.typeByProvider`** *(Record<string, DiscoveryType>)*: Specify protocol adapter per provider (`openai-compat`, `ollama`, `anthropic-compatible`, `openai-responses`, `lm-studio`, `llama-cpp`, `static`).
- **`providers[].defaults`**: Fallback model defaults (context window, max tokens, cost, reasoning flags, input/output modalities) applied when remote endpoints do not provide them.

---

## 🔒 Security & Route Isolation

- **Credential Origin Isolation**: Each provider's credentials from `auth.json` are strictly bound to its own resolved `baseUrl`.
- **Safe Cross-Origin Protection**: Discovery requests reject cross-origin redirects and external endpoint hijacking to prevent credential leakage.
- **Secret Sanitization**: API keys and authorization headers are scrubbed and never output to console streams, JSON results, cache files, or logs.
- **Safe Persistence**: Writes to `models.json` use atomic file writes and create `.bak` backups before modifying your configuration.

---

## 📄 License

MIT © [MasuRii](https://github.com/MasuRii)
