# dsh-plugins

[![awesome · DSH plugins](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![GitHub stars](https://img.shields.io/github/stars/summerscar/dsh-plugins?style=flat-square)](https://github.com/summerscar/dsh-plugins)

[简体中文](README.zh-CN.md) / English

DeepSeek Harness (DSH) plugins by summerscar. Browse install commands and each plugin's documentation on the [plugin site](https://summerscar.github.io/dsh-plugins/).

## Plugins

| Package | What it does |
| --- | --- |
| [`@summerscar/dsh-connect-agentscope-platform`](plugins/dsh-connect-agentscope-platform/README.md) | AgentScope Platform: manage several platform accounts (switch the billing account by hand, pick one by remaining Credits, probe and flag unhealthy ones), an optional OpenAI-compatible model provider whose catalog you can fetch and edit row by row, an available-Credits and redeemable-contribution readout under the composer, and a settings panel for the daily check-in, the balance, contribution grants, usage detail and the price list. Switching accounts affects new requests only. |
| [`@summerscar/dsh-mnemon-sync`](plugins/dsh-mnemon-sync/README.md) | Sync backup: back up dsh-mnemon memory spaces, project documents, runtime memory and user-level skill files to S3-compatible storage or WebDAV, with scheduled backups and selective restore. |

## Install

Replace `web` with your profile name and restart the profile after installing.

```sh
dsh plugin --profile web add @summerscar/dsh-mnemon-sync
```

To browse the plugin list in DSH, enable the experimental **Custom Plugin Market** bundle, then choose **Plugins → Discover → Add index source** and enter:

```text
https://raw.githubusercontent.com/summerscar/dsh-plugins/main/index.json
```

The same source provides list updates. DSH asks for confirmation before installing any plugin.

## Development

Requires Node.js 24+ and pnpm 11.

```sh
pnpm install
pnpm check
```

The code is the developer documentation. Releases follow the [release guide](RELEASING.md).

## Plugin lifecycle

<!-- plugin-release-states:start -->
| Package | Lifecycle | Notes |
| --- | --- | --- |
| [@summerscar/dsh-connect-agentscope-platform](plugins/dsh-connect-agentscope-platform/README.md) | Published (`published`) | Published on npm; subsequent versions follow the normal update workflow. |
| [@summerscar/dsh-mnemon-sync](plugins/dsh-mnemon-sync/README.md) | Published (`published`) | Published on npm; subsequent versions follow the normal update workflow. |
<!-- plugin-release-states:end -->

## License

[SATA License 2.1](LICENSE). Versions up to and including 0.1.11 published on npm remain MIT.
