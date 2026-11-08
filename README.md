# dsh-mnemon-sync

为 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) 提供备份与恢复：把记忆组件打包上传到 S3 兼容存储或 WebDAV，需要时挑一个包恢复回来。安装后在记忆系统里多一个「同步备份」标签页。

## 安装

```sh
dsh plugin --profile web add @summerscar/dsh-mnemon-sync
```

装完重启 DSH 生效。没有 `dsh-mnemon` 时插件仍可运行，只是不显示标签页。

## 能备份什么

三个组件任意组合，默认全选：

| 组件 | 内容 |
|---|---|
| 记忆空间 | `<MNEMON_DATA_DIR>/data/`，每个空间的 `mnemon.db` 与空间清单 |
| 项目档案 | `<MNEMON_DATA_DIR>/documents/`，`index.json` 与全部 Markdown |
| 运行时记忆 | `<MNEMON_DATA_DIR>/runtime/`，`memories.json` 与两份投影 |

`MNEMON_DATA_DIR` 未设置时取 `~/.mnemon`。

## 备份目标

- **S3 兼容** — 手写 AWS Signature V4，适用于 Cloudflare R2、MinIO、Backblaze B2 等
- **WebDAV** — Basic 认证，自动创建远端目录

凭据存在 `<MNEMON_DATA_DIR>/state/mnemon-sync.json`，权限 `0600`，不写入 DSH 配置，也不进备份包。页面只回显掩码，回传掩码表示不修改。

## 自动备份

关闭 · 每小时 · 每 3 / 6 / 12 小时 · 每天 · 每 3 天 · 每 7 天

## 恢复

从备份列表查看明细，选择要恢复的组件后执行；缺少的组件会明确提示。恢复默认只做预览，确认后才写盘。

数据库用 `node:sqlite` 的 `backup()` 在线备份，副本一致；写回前会删掉同名 `-wal` / `-shm`，避免 SQLite 重放不存在的事务。每个文件都有 SHA-256 校验。

## 许可

MIT
