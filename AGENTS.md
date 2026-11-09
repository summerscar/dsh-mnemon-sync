# AGENTS.md

本仓库是 summerscar 的 DSH 插件 monorepo，托管插件发布站 <https://summerscar.github.io/dsh-plugins/>。
专项规则按需加载：在 `plugins/**` 下开发插件时遵循 `plugins/AGENTS.md`；改动 `site/**` 时遵循 `site/AGENTS.md`（站点结构、catalog 规则、渲染与部署）。

## 排查问题的顺序

功能异常时**先检查本仓库的插件代码**：查相关插件源码、配置、依赖声明和最近改动（`git log` / `git diff`），确认本仓实现正常后再对照 DSH 运行时和第三方插件。涉及宿主或上游的结论以实测证据为准。

## 文档

文档只写给用户看，代码本身就是开发文档。

- **README 只回答四件事**：做什么、怎么装、怎么用、主要限制。RPC、内部 API、存储路径、schema、主题 token、兼容层、实现流程、错误码和迁移细节留在源码中。
- **开发说明写进代码与提交**：设计理由写进代码注释、提交信息或 PR；临时记录放 `.scratch/`，用完删除。仓库只保留面向用户的文档。
- **只写用户实际用得到的能力**：先在代码里找到工具注册、RPC 或界面入口再写，只记录已有入口的功能。
- **保持内容持久有效**：最低版本以 `package.json` 的 `engines` 为准；正文省略具体的 DSH 版本号、插件数量、日期、预发布通道和「已验证某版本」字样。
- **中英文成对维护**：结构一致、内容对应。
- **一处简介改了，几处一起改**：`package.json` `description`、`locale/zh.json` / `en.json` `meta`、`site/catalog.json` `summary`、根 README 插件表格、包内 README。
- **测试固定的内容**：每个包的 `README.md` 保留 `<!-- release-state-note -->`；根 README 生命周期表只由 `pnpm release:docs` 生成。

## 日常维护

- **改插件功能**：同步中英文 README；简介变化按「文档」一节同步各处。
- **新增插件**：`scripts/plugin-release-states.json` 登记 `draft`；备齐双语 README（带状态标记）、`LICENSE`、`locale/zh.json` / `en.json` 并列全 `files`；`homepage` 指向站点详情页；npm 有 `latest` 后再加入 catalog 和根 README 表格。
- **移除插件源码**：清单条目设 `retired: true`，保留阶段和发布凭据；从 catalog 和根 README 表格移除。
- **删除包内文件**：同步检查 `files`、测试文件清单、`plugin-release-states.json` 的 `evidence` 引用；保留既有的 `publication` 记录。

定期核对：catalog 与 npm 一致；README 与代码一致（以源码为准）；过时内容与死链。

验证按需选择：

```bash
pnpm release:docs # 改了生命周期清单或包列表后同步根 README
pnpm release:check # 生命周期、文档标记与发布脚本回归
pnpm site:test # 改了 catalog 或 site/
pnpm --filter @summerscar/dsh-mnemon-sync test # 改了插件就测插件
pnpm pack:check # 改了 files 或包内文件
git diff --check
pnpm check # 较大改动时全仓检查
```

提交、推送、npm 发布和站点部署都需用户明确授权；本地清理和文档修改属于本地操作。

## 本地 pnpm 调用

根 `package.json` 固定 `pnpm@11.28.5`（CI 由 `pnpm/action-setup@v4` 安装同一版本）。本机直接运行 `pnpm <script>` 即可；若本机 corepack 缓存里还有旧版 pnpm，`corepack pnpm check` 会因脚本内嵌套的 `pnpm` 调用报「current pnpm is v11.7.0」——这是本机双版本 corepack 的拦截，不是仓库问题，改用不带 corepack 的 `pnpm` 即可。

## 与 npm 发布的关系

完整规则见 `RELEASING.zh-CN.md`，日常只需记住三条：生命周期 `draft` → `testing` → `published` 单向推进，`publication` 凭据永久保留；首次发布须由工作流 `first_release` 或 `plan --first-release` 明确选择；改清单后跑 `pnpm release:docs` + `pnpm release:check`。只改 `site/`、根 README 或未打包测试时保持当前发布状态。

发布认证走 **npm Trusted Publishing（OIDC）**：`npm-publish.yml` 用 `id-token: write` 领取短时凭据，不读 `NPM_TOKEN`；npmjs.com 上要为 `npm-publish.yml` 绑定 Trusted Publisher。bypass-2FA 直发 token 将于 2027 年 1 月停用，不要再新建。

## 运行时契约（重构时禁止顺手改名）

以下字符串写进了已有备份包、已保存配置与 dsh-mnemon 页面目录，改动会导致旧备份不可恢复 / 配置丢失 / 标签页消失：

- `index.js`：`name = 'dsh-mnemon-sync'`、`/api/mnemon-sync`、`mnemon-sync-`、`state/mnemon-sync.json`、`state/mnemon-sync-work`、`mnemon-sync-snapshot`
- `source.js`：`SYNC_SOURCE_TYPE_ID = 'mnemon-sync'`、`SYNC_PACKAGE_NAME = '@summerscar/dsh-mnemon-sync'`
- `client.js`：`NS = 'mnemon-sync'`、`SOURCE_TYPE_ID`、`PAGE_ID`、模块 `id`
- `cordis.patch.yml`：两个 Entry 的 `name`
- `locale/*.json` 的 `meta`

`test/smoke.test.mjs` 会断言上述字符串，review diff 时也应逐项确认这些文件零改动。
