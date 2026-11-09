# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

**变更**

- 仓库更名为 `dsh-plugins`，重构为 pnpm monorepo：插件源码整体迁入 `plugins/dsh-mnemon-sync/`，`git mv` 保留全部提交历史。npm 包名 `@summerscar/dsh-mnemon-sync` 不变，现有安装与更新链路不受影响。
- npm 包 meta 更新：`repository` / `bugs` / `homepage` 指向新仓库与发布站，`repository.directory` 标注子目录；`publishConfig` 补 `registry`。
- `engines.dsh` 与 `dsh.compatibility.dsh` 去掉 `<0.3.0-0` 上界，改为 `>=0.2.1-rc.1`，避免 loader 命中 profile 里的旧拷贝而停用插件；`keywords` 补 `dsh-plugins`。
- 根许可证改用 **SATA 2.1**，包内 `LICENSE` 为同文副本；`package.json` 的 `license` 改为 `SEE LICENSE IN LICENSE`。**0.1.11 及之前发布在 npm 上的版本仍为 MIT，历史 tarball 不变。**
- 包内 README 拆成英文 `README.md` 与中文 `docs/README.zh-CN.md`，`files` 同步列出；中文文档的相对链接改为 `../`。
- 新增 `test/smoke.test.mjs`（`node --test`）与 `scripts` / `test` 命令；新增根工作区骨架、发布状态机、发布站、市场索引与 CI/发布工作流，详见根 [README](../README.zh-CN.md)。

## 0.1.11

**新增**

- 随包附带「同步备份」页截图：`assets/screenshot-config.png` 与 `screenshots.json`（插件市场约定 1–8 张），README 同步嵌入；`files` 补上 `assets/*` 与 `screenshots.json`，保证 npm 发布包里真的带图。

## 0.1.10

**修复**

- **S3 列不出备份**：ListObjectsV2 是桶级操作，此前把 `remotePath` 拼进请求路径，对象存储回 `404 NoSuchKey`。现在请求桶根，文件夹改由 `prefix` 查询参数给出。
- **S3 签名不匹配**：canonical query 用 RFC 3986 编码，但 `URLSearchParams` 字符串化会把空格变成 `+`，签名覆盖的与实际发出的不一致。现在按同一套编码手工序列化 wire query。

## 0.1.9

**修复**

- **安全**：恢复时把写入目标严格限制在 `data/`、`documents/`、`runtime/` 三个组件目录内。此前只校验「不逃出 Mnemon home」，备份包里 `payload/data/../state/mnemon-sync.json` 这类条目仍会解析到 home 内并覆盖插件凭据或机器标识。现在 `payload/` 后首段必须精确命中白名单，且拒绝 `..`、空段与 NUL；非法条目直接报错，不静默跳过。

## 0.1.8

**修复**

- **安全**：全部 HTTP 接口接入宿主认证（`connection.requestRejection`）。这些接口能读凭据、触发上传、把备份写回磁盘，此前本机任意请求都能调用；兼容只暴露 `authorizeIndex` 的旧宿主，两者都不可用时一律返回 401，不再回退到 Host/Origin/loopback 判断。
- 0.1.7 已发布且不含上述认证修复，故随即 bump 到 0.1.8 重新发布。

## 0.1.7

**新增**

- `compatibility.profiles` 增加 `desktop`；README 补桌面版说明（`desktop` profile 由 Electron 应用独占管理，`dsh plugin --profile desktop` 会被 dsh 自身拒绝）。

## 0.1.6

**变更**

- 补全插件目录/市场上架字段：`dsh.catalog`（分类 `tool`、中英简介、能力声明 `webServer` / `mnemonMemory` / `slots` / `locale`）与 `dsh.compatibility`（DSH `>=0.2.1-rc.1 <0.3.0-0`、适用 profile）。
- `exports` 增加 `./package.json`，声明 `icon: ./icon.svg`；`homepage` 最终定回 GitHub 仓库地址。

## 0.1.5

**新增**

- 备份文件名带设备名：`mnemon-sync-<设备名>-<时间戳>.zip`。设备名取自 dsh-mnemon 的 `state/machine.json`，多台机器备份到同一目录也能分辨来源。

**修复**

- 保留策略按运行时间排序，不再按文件名字符串。加了设备名后文件名以设备开头，旧逻辑会按设备分组，可能删掉本机较新的备份而留下其他机器最旧的。

## 0.1.4

**修复**

- 备份列表按创建时间倒序。此前用字符串比较 RFC1123 日期，跨天时会排错（`09 Nov 23:00` 排在了 `10 Nov 01:00` 前面）。现改为解析时间戳比较，同时兼容 S3 的 ISO 格式。

## 0.1.3

**修复**

- **标签页不显示**。Source 入口改为标准 Cordis 插件形态（`inject` + `apply` + `installMemory`），并把 bundle patch 拆成两个 Entry（Host 引擎 + Source）。
- SDK 改用 `createRequire` 同步加载，先试裸包名、失败再按 `DSH_PROFILE_DIR` 拼绝对路径 —— 修复 `link:` 安装下静态 `import` 报 `ERR_MODULE_NOT_FOUND` 的问题。

## 0.1.2

**变更**

- 插件 meta 文案与功能对齐：标题改为「同步备份」，描述改为三组件任选 + 备份列表 + 选择性恢复。
- README 精简，安装命令改为 npm 包名。

## 0.1.1

**修复**

- **关键**：恢复掩码密钥时不再把掩码本身写进配置。此前 `/run` 接口接受页面草稿配置却未做掩码还原，会把 `••••••••` 当成真实密码存盘，导致配置看着正确、备份却一直 401。

**新增**

- 运行记录支持一键清空（只清本地日志，不动目标上的备份包）。

## 0.1.0

首个版本。

- 三组件（记忆空间 / 项目档案 / 运行时记忆）任意组合备份
- S3 兼容存储（手写 SigV4）与 WebDAV 两种目标
- 定时备份：关闭 · 每小时 · 3/6/12 小时 · 每天 · 3/7 天
- 备份列表、明细查看、选择性恢复
- 数据库走 `node:sqlite` 的 `backup()` 在线备份，每文件 SHA-256 校验
