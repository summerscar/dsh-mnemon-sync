<div align="center">

# dsh-connect-agentscope-platform

<!-- release-state-note -->

**AgentScope Platform inside DeepSeek Harness — an optional model provider, credits under the composer, and a settings page for the daily check-in, contributions and usage.**

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

[简体中文](docs/README.zh-CN.md) · English

</div>

---

## What it does

AgentScope Platform sells model calls by Credits, and its console already shows the balance — this plugin brings that account into DSH instead of a browser tab, and optionally routes model calls through the platform.

- **Model provider, opt-in.** Off by default. Switch it on in the settings page and `AgentScope Platform` appears in the model picker; switch it off and the route disappears immediately, with no restart. Credits, the check-in and usage keep working either way.
- **Model catalog you control.** Fetch the available models from the platform, add rows by hand, and edit every row: model ID, display name, context window, output cap, input types (text and image are both ticked by default), and reasoning tiers with the API value each tier sends.
- **Credits under the composer.** A small readout next to the model picker shows the available Credits and redeemable contribution, refreshed every five minutes and on demand. It never blocks typing.
- **Settings page.** Two credentials with their own jobs (a login token for account reads, an `sk-as-` key for model calls), the provider switch, the catalog editor, the daily check-in, the credit balance, claimable grants, contribution redemption, a paginated usage-detail query filtered by date range, record type and model, and the console's price list — grouped by capability, collapsed until you open a group.

## Install

```sh
dsh plugin --profile web add @summerscar/dsh-connect-agentscope-platform
```

Restart DSH, then open **Settings → AgentScope Platform**.

> **Desktop:** install it from the desktop app's plugin page. The `desktop` profile is managed by the Electron app; `dsh plugin --profile desktop` is rejected by DSH itself.

## Configure

1. **Sign-in credentials.** A single **refresh token** is enough: paste it and the plugin exchanges it for a working pair on save, then keeps renewing on its own. The refresh token rotates on every use, so each exchange mints a new pair and retires the old one. In a browser signed in to platform.agentscope.io, run `localStorage.getItem('refreshToken')` in the console and paste the result. An `accessToken` can be pasted instead, but it expires in about two hours.
2. **Model key.** Either press **Fetch with the login token** (the platform hands the key back only right after generation or reset) or paste an `sk-as-…` key by hand. **Reset and fetch a new one** rotates it, which revokes the old key at once.
3. **Model provider.** Switch it on when you want AgentScope in the model picker.
4. **Catalog.** Press **Fetch available models**, tick what you want, then edit any row. Context window and output cap are left **empty** on purpose: this plugin does not invent them. An empty box shows the public model table's range as a grey hint (min~max), the value you type wins, and clearing the box falls back to the table.
5. **Daily check-in.** Switch it on and the plugin keeps the login alive once a day and reports what the platform's contribution ledger says about today.

## Main limits

- **The platform has no check-in endpoint.** Its "daily login +1" contribution is scored by the server when the account signs in, so this plugin keeps the login alive and then reads the ledger back. The page reports *scored*, *waiting for the platform to score it*, or *failed* — it never claims a check-in on the strength of its own request.
- **Chat is the only modality wired up.** The chat endpoint accepts text and image input, which is why rows default to text + image. Image *generation*, text-to-speech, speech recognition and video run on a different protocol and are out of scope here.
- **Reasoning tiers are opt-in per model.** The platform publishes no fixed parameter name for them, so a tier only reaches the wire when you enable it on that row and give it a value.
- **Model capacities are the plugin's own placeholders or a third-party public table**, not published platform figures. Every row is editable, and the catalog shows where its numbers came from.
- **The model provider rides on the Host's own pi-ai adapter.** A DSH build that does not ship it registers no route when the switch is on; the credits, check-in and usage keep working.
- **One account per installation.** The plugin stores one login and one model key.

Credentials stay on the host. The browser only ever receives masks, and no token is written into the page.
