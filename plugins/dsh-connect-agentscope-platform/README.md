<div align="center">

# dsh-connect-agentscope-platform

<!-- release-state-note -->

**AgentScope Platform inside DeepSeek Harness — an optional model provider, credits under the composer, and a settings page for the daily check-in, contributions and usage.**

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm version](https://img.shields.io/npm/v/@summerscar/dsh-connect-agentscope-platform?style=flat-square)](https://www.npmjs.com/package/@summerscar/dsh-connect-agentscope-platform)
[![license](https://img.shields.io/badge/license-SATA--2.1-blue?style=flat-square)](LICENSE)

[简体中文](docs/README.zh-CN.md) · English

</div>

---

## What it does

AgentScope Platform sells model calls by Credits, and its console already shows the balance — this plugin brings that account into DSH instead of a browser tab, and optionally routes model calls through the platform.

- **Model provider, opt-in.** Off by default. Switch it on in the settings page and `AgentScope Platform` appears in the model picker; switch it off and the route disappears immediately, with no restart. Credits, the check-in and usage keep working either way.
- **Model catalog you control.** Fetch the available models from the platform, add rows by hand, and edit every row: model ID, display name, context window, output cap, input types (text and image are both ticked by default), and reasoning tiers with the API value each tier sends.
- **Credits under the composer.** A small readout next to the model picker shows the available Credits and redeemable contribution, refreshed every five minutes and on demand. It never blocks typing, and it appears only while the session is running on the AgentScope model — switch to another provider and it steps aside. That readout and the same account's row in the settings page are **one measurement**: refresh the composer and the row follows, with the same balance and the same "last refreshed" instant.
- **Account pool.** Keep several AgentScope accounts side by side and decide which one pays for new requests. Each account carries its own login token, model key, credit history and check-in record; add, rename, disable or delete them from the page, or let the plugin pick by Credits against a threshold you set.
- **Settings page.** The account pool, two credentials with their own jobs (a login token for account reads, an `sk-as-` key for model calls), the provider switch, the catalog editor, the daily check-in, the credit balance, claimable grants, contribution redemption, a paginated usage-detail query filtered by date range, record type and model, and the console's price list — grouped by capability, collapsed until you open a group.

## Install

```sh
dsh plugin --profile web add @summerscar/dsh-connect-agentscope-platform
```

Restart DSH, then open **Settings → AgentScope Platform**.

> **Desktop:** install it from the desktop app's plugin page. The `desktop` profile is managed by the Electron app; `dsh plugin --profile desktop` is rejected by DSH itself.

## Configure

1. **Account pool.** The page keeps a list of accounts, each with its own credentials, Credits and check-in record, and shows at a glance which one is the billing account, whether its credentials still work, and how many Credits it last reported.
   - **Manage the list.** Add an account by pasting its refresh token, then rename, disable, re-enable or delete it at any time. Disabling an account takes it out of automatic picking without losing its records.
   - **Choose the billing account.** Exactly one account is the **billing account**: every request that does not name an account is charged to it, and a switch changes the account used by requests started after that moment.
   - **Pick by Credits.** Switch it on and set a threshold: when the billing account's balance falls below it, the plugin compares the other usable accounts at its next check and moves to the one with the most Credits. Leave it off to keep the choice manual.
   - **Probe one account.** Probe tests a single account and marks what it found — credentials expired, out of Credits, or healthy — so a broken account stops being picked instead of silently failing. A network hiccup is not recorded as an expired credential.
   - **Edit one account's credentials.** Each row opens its own editor: replace the refresh token, fetch or paste a model key, and set that account's polling interval. The fields always belong to the account whose row you opened. The provider switch, model catalog and model metadata are shared by every account.
2. **Sign-in credentials.** A single **refresh token** is enough: paste it and the plugin exchanges it for a working pair on save, then keeps renewing on its own. The refresh token rotates on every use, so each exchange mints a new pair and retires the old one. In a browser signed in to platform.agentscope.io, run `localStorage.getItem('refreshToken')` in the console and paste the result. An `accessToken` can be pasted instead, but it expires in about two hours.
3. **Model key.** Either press **Fetch with the login token** (the platform hands the key back only right after generation or reset) or paste an `sk-as-…` key by hand. **Reset and fetch a new one** rotates it, which revokes the old key at once.
4. **Model provider.** Switch it on when you want AgentScope in the model picker. This is one setting for the whole installation, not one per account.
5. **Catalog.** Press **Fetch available models**, tick what you want, then edit any row. Context window and output cap are left **empty** on purpose: this plugin does not invent them. An empty box shows the public model table's range as a grey hint (min~max), the value you type wins, and clearing the box falls back to the table. The catalog is shared by every account.
6. **Daily check-in.** Switch it on and the plugin keeps the login alive once a day and reports what the platform's contribution ledger says about today.

## Main limits

- **The platform has no check-in endpoint.** Its "daily login +1" contribution is scored by the server when the account signs in, so this plugin keeps the login alive and then reads the ledger back. The page reports *scored*, *waiting for the platform to score it*, or *failed* — it never claims a check-in on the strength of its own request.
- **Chat is the only modality wired up.** The chat endpoint accepts text and image input, which is why rows default to text + image. Image *generation*, text-to-speech, speech recognition and video run on a different protocol and are out of scope here.
- **Reasoning tiers are opt-in per model.** The platform publishes no fixed parameter name for them, so a tier only reaches the wire when you enable it on that row and give it a value.
- **Model capacities are the plugin's own placeholders or a third-party public table**, not published platform figures. Every row is editable, and the catalog shows where its numbers came from.
- **The model provider rides on the Host's own pi-ai adapter.** A DSH build that does not ship it registers no route when the switch is on; the credits, check-in and usage keep working.
- **Switching accounts only affects new requests.** A conversation already streaming keeps the account it started on and runs to the end; the switch takes effect on the next request you start.
- **No failover inside a request.** If a request fails — the balance ran out between two checks, or the credentials expired since the last probe — it fails. Nothing automatically retries it on another account; switch accounts by hand, or let the next scheduled pick use the healthier one. Turning on automatic picking is not a guarantee that a request cannot fail.

Credentials stay on the host. The browser only ever receives masks, and no token is written into the page.
