# 插件生命周期与发布

[English](RELEASING.md) · [当前清单](README.zh-CN.md#插件生命周期)

`scripts/plugin-release-states.json` 记录 `plugins/*` 下每个包的生命周期，单向推进：**草稿（draft）→ 测试（testing）→ 已发布（published）**。

| 阶段 | 含义 | 发布 |
| --- | --- | --- |
| `draft` | 开发中，尚未测试 | 仅本地开发 |
| `testing` | 正在完成首次交付的检查与验收 | 仅在被明确选为首次发布时发布 |
| `published` | 已有 npm 发布记录（含预发布） | 通过正常更新流程维护 |

修复、README 改动、新功能测试与版本更新都让已发布的包保持 `published`；检查失败只阻断那一次更新。

## 当前状态

`@summerscar/dsh-mnemon-sync` 为 `published`，npm 上已有 `0.1.11`（发布时间 `2026-11-09T11:21:23.618Z`，带已核验的归档完整性）。`publication` 记录是不可变的历史凭据，禁止编辑或删除。后续版本走正常更新流程，不需要 `first_release` 选择。

## 日常维护

1. 在保持 `published` 的前提下改动源码、配置、依赖或随包发布的文档。
2. 按兼容性选定版本，跑相关测试、构建、归档检查与目标宿主验收。
3. 发布器对比当前归档内容与 npm、跑 `pnpm check`、重新校验已保存的计划、发布并核验归档下载；失败的那次运行不改变生命周期阶段。`README*.md`、`CHANGELOG*.md`、`docs/` 的改动会打进归档，随下一次代码发布一起上线。

发布暂缓写在 `scripts/npm-release-holds.json`，条件满足后清除。

## 首次发布（供将来新增包使用）

新包登记为 `draft`，准备好后手动推进到 `testing` 并同步文档。首次发布前检查最终归档、许可证、依赖、入口、相关测试与目标宿主场景。经明确授权后，在 Actions 手动运行 **Publish npm plugins**，在 `first_release` 里填完整包名。归档能匿名下载且完整性匹配后，生命周期才推进为 `published`。

## 生命周期校验

```sh
pnpm release:status # 生命周期、私有状态与阻断项
pnpm release:docs # 同步根 README 的两张表
pnpm release:check # 生命周期、文档与发布脚本回归
pnpm release:fingerprint @summerscar/dsh-mnemon-sync # 只读诊断内容
```

清单使用 `schemaVersion: 2`。本地校验对比工作树与 `HEAD`，发布 CI 会把 `RELEASE_STATE_BASE` 设为推送前提交。校验要求阶段只能经 `testing` 向前推进，且 `publication` 记录必须保留。

## 本次重构后恢复自动发布的注意事项

monorepo 重构改变了打包归档内容（新增双语 README、LICENSE、meta 变更）。推送到 `main` 会触发 `npm-publish.yml` 自动计划并发布有变化的包。**本次重构后的第一次推送前，必须取得用户明确授权**；发布后用 `npm view @summerscar/dsh-mnemon-sync@latest` 核对 `repository`、`homepage`、`license`、`engines`。提交、推送、npm 发布与站点部署均需用户明确授权。

## 计划内容与依赖

计划会记录包及其本地依赖闭包的 `sourceHashes`，发布前重新计算，并要求当前源码、依赖与归档内容与计划一致。处于暂缓状态、需要提供 npm 版本的依赖，必须已经发布了那个确切版本。
