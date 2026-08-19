# pi-commandcode-provider

[![CI](https://github.com/patlux/pi-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/patlux/pi-commandcode-provider/actions/workflows/ci.yml)
[![Memory benchmark](https://github.com/patlux/pi-commandcode-provider/actions/workflows/memory-benchmark.yml/badge.svg)](https://github.com/patlux/pi-commandcode-provider/actions/workflows/memory-benchmark.yml)

A custom provider for [pi](https://github.com/earendil-works/pi) that connects to the [Command Code](https://commandcode.ai) Provider API.

> **Disclaimer:** This is an unofficial, community-maintained integration. It is not affiliated with, endorsed by, or supported by Command Code. You need your own Command Code account, API key, and a plan with Provider API access. Command Code's terms, availability, and pricing apply.

The extension uses one provider and automatically selects the transport supported by the authenticated account:

- `GET /provider/v1/models` for model discovery
- `POST /provider/v1/chat/completions` for non-Claude models with Provider API access
- `POST /provider/v1/messages` for Claude models with Provider API access
- `/alpha/generate` after the Provider API explicitly returns `403 upgrade_required`, which currently identifies Go-plan accounts

The detected transport is remembered only for the running process and is re-evaluated when the credential changes. Other authentication, permission, rate-limit, network, and server errors never trigger the fallback.

## Install

```sh
pi install npm:pi-commandcode-provider
```

Start or reload pi, then authenticate:

```txt
/login
```

Select **Use a subscription**, then **Command Code**. Choose browser login or paste an API key, then select a model with `/model`.

## Oh My Pi

Install the same package in [Oh My Pi](https://github.com/can1357/oh-my-pi):

```sh
omp plugin install pi-commandcode-provider
```

Restart OMP or run `/reload`, then use `/login` and select **Use a subscription** followed by **Command Code**.

## Authentication

### Login dialog

Run `/login` in pi or OMP. Select **Use a subscription**, then **Command Code**. Press Enter for browser login, type `key` to open a paste prompt, or paste the API key directly. The selected credential is stored in the host's auth file.

<img width="1520" height="554" alt="Select Command Code in pi's login dialog" src="https://github.com/user-attachments/assets/071e929a-6f49-4803-bfec-7a31368fb12a" />

If automatic transfer from the browser fails, copy the API key shown by Command Code and paste it into the terminal prompt.

### Environment variable

```sh
export COMMANDCODE_API_KEY="user_..."
```

### Auth file

The provider also reads existing credentials from:

- `~/.commandcode/auth.json`
- `~/.pi/agent/auth.json`
- `~/.omp/agent/auth.json`

Supported examples:

```json
{
  "apiKey": "user_..."
}
```

```json
{
  "command-code": {
    "type": "api",
    "key": "user_..."
  }
}
```

```json
{
  "commandcode": "user_..."
}
```

## Usage

Open `/model` and select one of the models provided by Command Code. Model availability changes over time and is refreshed from the Provider API when the extension loads.

### Reasoning support

Reasoning metadata is enriched only for models whose Command Code effort support is known. Those models register a model-specific `thinkingLevelMap`, so pi and OMP expose only supported levels. Pi's native OpenAI- and Anthropic-compatible providers translate the selected level for Provider API accounts; the existing Command Code generate transport sends the matching `reasoning_effort` for Go accounts. Unsupported levels and newly discovered models without metadata do not claim reasoning support.

List Command Code models from the terminal:

```sh
pi --list-models commandcode
```

In OMP, use:

```sh
omp models
```

For non-interactive OMP requests, use a provider-qualified model ID shown by `omp models`. For example:

```sh
omp -p "hello" --model commandcode/deepseek/deepseek-v4-flash
```

## Model discovery and offline behavior

The provider fetches the current model catalog from:

```txt
https://api.commandcode.ai/provider/v1/models
```

The last successful catalog is cached at `<agent-dir>/commandcode-models.json`. For pi this is `~/.pi/agent/commandcode-models.json` by default. Compatible hosts such as OMP use their own agent directory.

If the endpoint is temporarily unavailable, the provider uses the cached catalog. On a first offline start without a cache, pi still loads, but Command Code models remain unavailable until the connection is restored and `/commandcode-refresh` succeeds.

While pi is running, use these provider commands without restarting:

- `/commandcode-refresh` fetches and re-registers the current model catalog. Overlapping refreshes are coalesced, and a failed refresh keeps the last valid catalog active.
- `/commandcode-status` shows redacted discovery diagnostics, including the source, model count, timestamps, cache path, endpoint, and warning.

Set `COMMANDCODE_ZDR=1` to send Command Code's documented `x-cmd-zdr: 1` zero-data-retention header.

The following environment variables are intended for tests, local mocks, and compatible API endpoints:

- `COMMANDCODE_API_BASE`
- `COMMANDCODE_MODELS_URL`
- `COMMANDCODE_MODELS_CACHE`
- `COMMANDCODE_MODELS_TIMEOUT_MS` (defaults to 10 seconds; invalid or non-positive values use the default)

## Image input

The provider advertises image input only for models marked with the `image` input modality in the official Command Code CLI model catalog. The capability snapshot currently follows `command-code@1.15.1`; unknown models default to text-only until their upstream metadata is reviewed.

For vision-capable models, Pi's native provider adapters forward image blocks from user messages and tool results using the documented OpenAI or Anthropic message schema. Unknown and text-only models remain marked text-only in Pi.

## Pricing display

The Command Code Provider API does not currently include prices in its model catalog. This extension therefore keeps a static table for models with known prices so pi can display estimated request costs. DeepSeek V4 uses time-dependent rates; pi displays the documented off-peak rate, which applies for 17 hours per day.

Models missing from that table display zero cost in pi. This does **not** mean that Command Code will bill the request at zero. The Command Code Usage page remains authoritative for each request. Check the current [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits) before relying on the displayed value.

## Update and remove

Update installed pi packages:

```sh
pi update --extensions
```

Remove the provider:

```sh
pi remove npm:pi-commandcode-provider
```

For OMP:

```sh
omp plugin upgrade pi-commandcode-provider
omp plugin uninstall pi-commandcode-provider
```

## Development

Start an isolated pi instance with only the current checkout installed and no existing Command Code credentials:

```sh
npm run pi:isolated
```

Run `/login` inside pi. Temporary credentials, configuration, and sessions are deleted when pi exits.

Start the current checkout with your existing pi credentials and only Command Code models in the model picker:

```sh
npm run pi:authenticated
```

Both commands accept additional pi arguments after `--`, for example `npm run pi:authenticated -- --model claude-sonnet-4-6`.

### Live transport tests

Keep the Go-plan and Provider-API test keys in separate secret-manager entries. Pass them through protected files so the keys do not enter shell history:

```sh
COMMANDCODE_E2E_GO_API_KEY_FILE=/path/to/go-key \
  npm run test:e2e:live:go

COMMANDCODE_E2E_PROVIDER_API_KEY_FILE=/path/to/provider-key \
  npm run test:e2e:live:provider

COMMANDCODE_E2E_GO_API_KEY_FILE=/path/to/go-key \
COMMANDCODE_E2E_PROVIDER_API_KEY_FILE=/path/to/provider-key \
  npm run test:e2e:live:all
```

Each profile runs with an isolated Pi agent directory and asserts the selected transport through `/commandcode-status`: Go must select `generate`, while a Provider API account must select `provider`. The profile-specific `*_API_KEY` environment variables are also supported for CI secrets, but key files are preferred for local use.

Override the default DeepSeek test model with `COMMANDCODE_E2E_GO_MODEL` or `COMMANDCODE_E2E_PROVIDER_MODEL`. A successful live Anthropic `/provider/v1/messages` test requires a Provider API account whose plan includes the selected Claude model.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and tests. See [RELEASE.md](RELEASE.md) for the release process.

## License

MIT
