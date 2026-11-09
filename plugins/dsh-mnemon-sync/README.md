<div align="center">

# dsh-mnemon-sync

<!-- release-state-note -->

**Back up and restore dsh-mnemon memory — archive it to S3-compatible storage or WebDAV, then pick a snapshot to bring back.**

[![npm version](https://img.shields.io/npm/v/@summerscar/dsh-mnemon-sync?style=flat-square&color=blue)](https://www.npmjs.com/package/@summerscar/dsh-mnemon-sync)
[![npm downloads](https://img.shields.io/npm/dm/@summerscar/dsh-mnemon-sync?style=flat-square)](https://www.npmjs.com/package/@summerscar/dsh-mnemon-sync)
[![license](https://img.shields.io/badge/license-SATA--2.1-blue?style=flat-square)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

[简体中文](docs/README.zh-CN.md) · English

</div>

---

`dsh-mnemon` keeps long-term memory in local SQLite databases and Markdown files. This plugin adds **off-site backup** and **on-demand restore**: once installed, the memory system gains a "Sync backup" tab.

![Sync backup page: choose components, target and cadence](assets/screenshot-config.png)

## Install

```sh
dsh plugin --profile web add @summerscar/dsh-mnemon-sync
```

Restart DSH, then open the memory system to find "Sync backup". The plugin still runs without `dsh-mnemon` installed — it just cannot show its tab.

> **Desktop:** install it from the desktop app's plugin page. The `desktop` profile is managed exclusively by the Electron app; `dsh plugin --profile desktop` is rejected by DSH itself.

## What it does

Pick any subset of three components (all selected by default): memory spaces, project documents and runtime memory. Archives go to S3-compatible storage (Cloudflare R2, MinIO, Backblaze B2, Aliyun OSS …) or a WebDAV server, on a timer from hourly to weekly. You can list the archives already on the target, inspect one, and restore only the components you choose. Restore previews by default; every file is SHA-256 verified before upload and again before restore, and live databases are copied through `node:sqlite`'s online `backup()`.

Credentials live in a `0600` file outside the DSH profile and are never packed into an archive. No runtime dependencies outside Node.

## Configuration

Everything is set on the "Sync backup" page. Saved secrets are shown only as a mask; leaving the mask (or the field) unchanged keeps the stored value.

See the [中文说明](docs/README.zh-CN.md) for field-by-field examples for S3 / Cloudflare R2 and WebDAV.

## Development

This repository is a pnpm monorepo; the plugin lives in `plugins/dsh-mnemon-sync/`.

```sh
git clone https://github.com/summerscar/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @summerscar/dsh-mnemon-sync test
pnpm check
```

The code is the developer documentation.

## License

[SATA 2.1](LICENSE). Versions up to and including 0.1.11 published on npm remain MIT.
