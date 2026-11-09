# dsh-plugins
[简体中文](README.zh-CN.md) / English

DeepSeek Harness (DSH) plugins by summerscar. Browse install commands and each plugin's documentation on the [plugin site](https://summerscar.github.io/dsh-plugins/).

## Plugins

| Package | What it does |
| --- | --- |
| [`@summerscar/dsh-mnemon-sync`](plugins/dsh-mnemon-sync/README.md) | Sync backup: back up dsh-mnemon memory spaces, project documents and runtime memory to S3-compatible storage or WebDAV, with scheduled backups and selective restore. |

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
| [@summerscar/dsh-mnemon-sync](plugins/dsh-mnemon-sync/README.md) | Published (`published`) | Published on npm; subsequent versions follow the normal update workflow. |
<!-- plugin-release-states:end -->

## License

[SATA License 2.1](LICENSE). Versions up to and including 0.1.11 published on npm remain MIT.
