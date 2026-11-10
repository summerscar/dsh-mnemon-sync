# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

**新增**

- 备份技能。记忆之外，技能其实分两处存放，插件此前一处都没备，换机器就只剩记忆、没有技能：
  - **技能文件（SKILL.md）**：用户级技能根 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）与 `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`）下真实的技能目录树，含 `references/` 等附带文件。压缩包里按「根种类 + 相对路径」存放，恢复时按本机实际的根还原，所以在另一台 `DSH_HOME` 不同的机器上也能正确落位。
  - **技能数据（mnemon）**：`<MNEMON_DATA_DIR>/skills/` 下的 `ledger.json`、`evals.json`、`versions/`、`trajectories/`、`market/`、`trash/`。体积大且可重算，想留在本机就把它留空。
  - 「备份范围」新增技能根目录列表，显示每个根的实际路径、是否存在、技能数与体积；不存在的根直接标注，避免备份包偏小而无人知晓。
  - **每个组件行都写明勾选后到底备什么**：技能数据那行直接标出它读取的绝对目录（`<MNEMON_DATA_DIR>/skills`），技能文件那行列出实际生效的用户级根路径，并在两个根都不存在时提示「勾选后会跳过」。此前只有名称和数量，读者无法判断一个勾选项覆盖的是哪个文件夹。
  - 新增 `build` 标记，用来确认正在运行的到底是哪一版代码。DSH 的 HMR 会在不重启容器的情况下热重载插件，而此时已经打开的页面不会自己刷新，旧模块同样能正常应答——「页面正常」「接口返回 200」都证明不了新代码生效。现在 `index.js` 导出 `BUILD`，经 `GET /api/mnemon-sync/status` 与 `POST /run` 的 `build` 字段返回，页面底部也显示「运行版本：…」。改完 Host 代码把末尾序号加一，读一次 `/status` 即可确认。
  - 恢复时技能文件只写入本机当前的两个用户级根；档案里出现的其它根种类（包括项目级）一律拒绝，不按档案里的路径落地。
- **两个技能组件默认都不勾选**，默认备份范围仍是原来的三项（记忆空间、项目档案、运行时记忆）。备份记忆是常规操作，搬技能则是主动决定：恢复会把文件直接写进技能根目录，不该作为「顺手备份一次」的副作用发生。已保存过设置的不受影响——改动默认值不会覆盖你已有的勾选。
- 备份清单格式升到 `version: 3`，记录这次新增的两个组件和「技能文件实际取自哪些根」。旧档案（`version: 2`）照常恢复：恢复侧按组件名分派，不依赖版本号。

**说明**

- 记忆空间的名称不再藏在悬停提示里：那一行现在直接写成「N 个空间 · 名字、名字」。原先数量之外要靠 hover 才能看到具体是哪些空间，触屏上根本没有 hover，桌面端也容易漏掉。

- **项目级技能（`<项目>/.dsh/skills`、`<项目>/.agents/skills`）不在备份范围**。它们是代码仓库的一部分，跟着 git 走；把它们复制进记忆备份等于给同一份内容制造第二个来源，恢复时还可能覆盖工作区。

**新增**

- 记忆目录可手动指定：dsh-mnemon 的存储位置不一定是默认的 `~/.mnemon`（`storageScope` 还可能是 `workspace` / `custom` / `workspaces`），而第三方 Source 拿不到这个值，所以「备份范围」新增数据目录输入框。留空即自动判断，填了就只读指定目录，页面显示当前实际读取的路径。插件自己的配置与运行记录仍固定在自动判断的目录下，不会被这一项搬走。

**修复**

- 恢复在 Windows 上必然失败，报 `archive entry cannot be restored safely: <第一个文件>`。路径归属判断原先写成 `destination.startsWith(root + '/')`：ZIP 条目名固定用 `/`，而 `resolve()` 返回平台分隔符，于是 Windows 上这个比较对**每一条**都是 false，恢复在遇到第一个文件时就被拦下（`.DS_Store` 只是恰好排在最前）。改用 `path.relative` 判断包含关系，两个平台都正确。
- 系统杂物文件不再进备份包：`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*` 资源分叉、编辑器 `.swp` / `~` 备份在列举与收集时就被排除。旧备份包里的这类文件在恢复时跳过并记入 `ignored`，不再让整个恢复失败。
- Windows（含桌面版）上数据根目录被解析成 `<profile 目录>/.mnemon`，页面显示的不是真实记忆目录。默认值原先读 `process.env.HOME`，而 Windows 只用 `USERPROFILE`，拿到 `undefined` 后 `join('', '.mnemon')` 退化成相对路径 `.mnemon`，再被 `resolve()` 锚到了进程工作目录。改用 `os.homedir()`，与 dsh-mnemon 自己解析 `~/.mnemon` 的方式一致；`MNEMON_DATA_DIR` 与 `dataRoot` 里的 `~` / `~\` 现在也会展开（此前会拼成字面量 `~` 目录）。

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
