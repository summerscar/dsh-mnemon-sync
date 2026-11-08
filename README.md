# dsh-mnemon-sync

为 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) 提供备份与恢复：把 Mnemon 的记忆组件打包上传到 S3 兼容存储或 WebDAV，需要时再挑一个包恢复回来。

在记忆系统里以「同步备份」标签页出现，和「概览」「检索」「内容」并排。

## 能备份什么

按 dsh-mnemon 自己的组件划分，任意组合，多选：

| 组件 | 内容 | 说明 |
|---|---|---|
| 记忆空间 | `<MNEMON_DATA_DIR>/data/` | 每个空间的 `mnemon.db` 与空间清单，数据库经 SQLite 在线备份 |
| 项目档案 | `<MNEMON_DATA_DIR>/documents/` | `index.json` 与全部 Markdown 文档 |
| 运行时记忆 | `<MNEMON_DATA_DIR>/runtime/` | `memories.json` 与两份投影文件 |

`MNEMON_DATA_DIR` 未设置时取 `~/.mnemon`。

## 为什么不用 litestream

litestream 是很好的工具，但和「目录级、多空间、可配置目标」这个需求是正交的：

- 一个 litestream 实例只盯一个数据库文件，v0.5 起每个数据库只允许一个副本。要备份整个 data 目录就得为每个记忆空间养一个常驻进程，空间增删还得动态改配置。
- 它接管 WAL checkpoint 并长期持有读锁。实测会让 `mnemon.db-wal` 停在非零字节，而 dsh-mnemon 自己的备份导出有这条检查：

  ```js
  if (existsSync(wal) && statSync(wal).size > 0)
    throw new Error(`Memory Space ${id} is busy (mnemon.db-wal is not checkpointed)`)
  ```

  也就是说上了 litestream，dsh-mnemon 自带的备份会直接报错。

这里改用 `node:sqlite` 的 `backup()`：它走 SQLite 自己的在线备份 API，写入方持有 WAL 也不会把副本撕开，并发写只会让备份重跑当前批次，不产生常驻进程。

## 一致性

- **数据库**：`backup()` 生成事务一致的副本，产物是已 checkpoint 的单文件，不含 `-wal` / `-shm`。
- **非数据库文件**：JSON 与 Markdown 由存储层原子写入，逐字节复制。
- **校验**：每个文件在打包前记录 SHA-256，manifest 与内容一起入包；上传前先自校验，恢复前再校验一次。
- **恢复顺序**：先下载 → 校验全部校验和 → 报告缺失组件 → 只写回确认的组件。不带 `apply` 时是纯预览，不碰磁盘。
- **覆盖数据库前**会先删除同名的 `-wal` / `-shm`：残留的 WAL 会让 SQLite 重放恢复文件里并不存在的事务。

## 目标

- **S3 兼容**：AWS Signature V4 手写实现，已用 AWS 官方文档的测试向量逐字节校验。适用于 Cloudflare R2、MinIO、Backblaze B2、阿里云 OSS 等。
- **WebDAV**：`PUT` 上传、`PROPFIND depth:1` 列目录、`DELETE` 清理，Basic 认证。

凭据保存在 `<MNEMON_DATA_DIR>/state/mnemon-sync.json`，权限 `0600`，不进 DSH 配置，也不会被备份包带走（`state/` 不属于任何备份组件）。页面回显密钥时只给掩码，回传掩码表示"不修改"。

## 自动备份

间隔与 dsh-mnemon 自己的 Git 备份保持一致，两项功能读起来一样：

关闭 · 每小时 · 每 3 / 6 / 12 小时 · 每天 · 每 3 天 · 每 7 天

调度是一个 Host 内唯一的 `setTimeout` 自循环，从 `finally` 里重新排期。每次触发前重新读配置，改间隔不用重启；运行中再次触发会被丢弃而不是排队；失败只记录不抛出。

## 安装

```sh
git clone https://github.com/summerscar/dsh-mnemon-sync.git
```

在 DSH 里用插件管理器安装这个目录，或直接加入 profile 的依赖：

```sh
dsh plugin --profile web add /path/to/dsh-mnemon-sync
```

需要在 profile 里启用，并确保 `mnemon.sync` 这一层出现在 `memoryTopology.layers` 中。插件会注册一个最小 Source 来承载自己的页面 —— dsh-mnemon 只会为真实存在的 Source 渲染标签页，且标签高亮按 `sourceTypeId` 分组，借用别人的类型会导致两个标签同时点亮。

## 目录结构

```
index.js      Host 入口：HTTP 接口、调度装配、Source 注册
source.js     承载页面身份的最小 Source（不存记忆）
snapshot.js   组件识别、数据库在线备份、manifest 与校验
scheduler.js  定时器与运行历史
store.js      设置存取（0600）与规范化
targets.js    S3 SigV4 / WebDAV 的上传、下载、列目录、删除
zip.js        零依赖 ZIP 读写（node:zlib）
client.js     浏览器端页面与标签注册
```

## 许可

MIT
