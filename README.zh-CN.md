# dsh-plugins

[![awesome · DSH plugins](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![GitHub stars](https://img.shields.io/github/stars/summerscar/dsh-plugins?style=flat-square)](https://github.com/summerscar/dsh-plugins)

简体中文 / [English](README.md)

summerscar 的 DeepSeek Harness（DSH）插件。可以在[插件站点](https://summerscar.github.io/dsh-plugins/)浏览安装命令和各插件说明。

## 插件

| 包 | 作用 |
| --- | --- |
| [`@summerscar/dsh-connect-agentscope-platform`](plugins/dsh-connect-agentscope-platform/docs/README.zh-CN.md) | AgentScope Platform：管理多个平台账号（手动切换计费账号、按额度自动选号、测活与健康标记），可自行开关的 OpenAI 兼容模型供应商（模型目录可自动获取并逐行修改），输入框下方的可用 Credits 与可兑换贡献值读数，以及包含每日签到、额度、贡献值、用量明细与价目表的设置面板。切换账号只影响新请求。 |
| [`@summerscar/dsh-mnemon-sync`](plugins/dsh-mnemon-sync/docs/README.zh-CN.md) | 同步备份：把 dsh-mnemon 的记忆空间、项目档案、运行时记忆与用户级技能文件备份到 S3 兼容存储或 WebDAV，支持定时备份与选择性恢复。 |

## 安装

```sh
dsh plugin --profile web add @summerscar/dsh-mnemon-sync
```

把 `web` 换成你的 profile 名，安装后重启该 profile。

要在 DSH 中浏览插件列表，先启用实验性的「自定义插件市场」组合包，再选择「插件 → 发现 → 添加索引源」，输入：

```text
https://raw.githubusercontent.com/summerscar/dsh-plugins/main/index.json
```

列表更新也来自这个索引源。安装任何插件前，DSH 都会要求确认。

## 开发

需要 Node.js 24+ 与 pnpm 11。

```sh
pnpm install
pnpm check
```

代码就是开发文档。发布流程见[发布指南](RELEASING.zh-CN.md)。

## 插件生命周期

<!-- plugin-release-states:start -->
| 包 | 生命周期 | 说明 |
| --- | --- | --- |
| [@summerscar/dsh-connect-agentscope-platform](plugins/dsh-connect-agentscope-platform/README.md) | 已发布 (`published`) | 已有 npm 发布记录；后续版本按正常更新流程维护。 |
| [@summerscar/dsh-mnemon-sync](plugins/dsh-mnemon-sync/README.md) | 已发布 (`published`) | 已有 npm 发布记录；后续版本按正常更新流程维护。 |
<!-- plugin-release-states:end -->

## 许可证

[SATA License 2.1](LICENSE)。0.1.11 及之前发布在 npm 上的版本仍为 MIT。
