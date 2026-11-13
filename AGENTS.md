# AGENTS.md

本仓库是 summerscar 的 DSH 插件 monorepo，托管插件发布站 <https://summerscar.github.io/dsh-plugins/>。
专项规则按需加载：在 `plugins/**` 下开发插件时遵循 `plugins/AGENTS.md`；改动 `site/**` 时遵循 `site/AGENTS.md`（站点结构、catalog 规则、渲染与部署）；往第三方市场（awesome-dsh-plugin、dsh-plugin-index）投递或更新条目时遵循 `.agents/skills/dsh-plugin-market-release/SKILL.md`。

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

## 验证

**开发时只跑 `pnpm lint`**：`scripts/lint.mjs` 用 `node --check` 静态解析 `plugins/` `scripts/` `site/` 下的 JS，只回答「代码写坏了没」，不跑测试、不碰发布流程、不联网、不需要宿主服务。改完代码随手跑一次即可，秒级完成。

**`pnpm check` 不在开发时跑**：它是提交前的全量闸门，由 husky pre-commit 钩子自动执行（生命周期清单、站点、插件测试、打包、市场索引都在这里）。开发阶段反复跑它既慢又会把无关的发布状态问题混进来。

按需选择的其他命令：

```bash
pnpm lint                      # 开发中：只检查 JS 语法（默认）
pnpm release:docs              # 改了生命周期清单或包列表后同步根 README
pnpm release:check             # 生命周期、文档标记与发布脚本回归
pnpm site:test                 # 改了 catalog 或 site/
pnpm --filter @summerscar/dsh-mnemon-sync test   # 改了插件逻辑要验证行为时
pnpm pack:check                # 改了 files 或包内文件
git diff --check
pnpm check                     # 提交前由 husky 自动跑；本地仅在明确需要全量校验时手动执行
```

提交、推送、npm 发布和站点部署都需用户明确授权；本地清理和文档修改属于本地操作。

**提交前先同步并 rebase 云端**：本仓发布工作流会在你工作期间基于同一祖先自动跑一版 `chore: record npm releases and plugin market index`（推高 `package.json` 版本号与 `dshRelease.contentHash`、刷新 `index.json`）。不先同步就 commit，push 必然 non-fast-forward 被拒。

- **commit 前**：`git fetch origin main`；若 `git log --oneline HEAD..origin/main` 非空，先把本地基线对齐到远端（已有未推送提交时用 `git rebase origin/main`；只有未提交的工作区改动时先 commit 再 rebase —— rebase 需要干净工作区），然后再继续。用 `git diff --stat HEAD..origin/main` 看清远端多了什么，多半只有 `package.json` 与 `index.json` 两处。
- **push 前**再 fetch 一次；远端若又前进，用 `git rebase origin/main` 把本地尚未推送的提交变基到远端之上（只改写本地未推送的历史，不动已发布的提交），跑一遍 `pnpm check`，最后 `git push origin main`。
- 不要盲目 `git pull`（会生成无意义的 merge commit），不要用 `--force` 覆盖远端的发布记录。`index.json` 两边常由 `pnpm site:market` 生成出完全相同的内容，rebase 一般不冲突；若 `pnpm check` 报它过期，重新跑一次 `pnpm site:market` 即可。
- **`index.json` 是发布工作流拥有的生成物，提交钩子会替你采用远端那份。** 它由 `pnpm site:market` 从 catalog 与 npm 现况生成，而发布工作流会在你工作期间推一条更新它的提交；`site:market:check` 又逐字节比对，于是「有未提交改动 + 本地落后」会死锁：commit 被闸门拦下，rebase 又要求干净工作区。所以 `.husky/pre-commit` 在满足**全部**下列条件时，会用 `git checkout origin/main -- index.json` 采用远端副本并暂存：`origin/main` 存在、它不是 HEAD 的祖先（本地落后或分叉）、本地提交没动过 `index.json`、本次也没暂存 `index.json` 的改动。作者自己改过的那份永远保留——那时本地才是更新的陈述，交由闸门判定。钩子**不联网**，只读本地已知的 `origin/main`，所以同步这一步仍然要靠上面的 `git fetch`。

## 本地 pnpm 调用

根 `package.json` 固定 `pnpm@11.28.5`（CI 由 `pnpm/action-setup@v4` 安装同一版本）。本机直接运行 `pnpm <script>` 即可；若本机 corepack 缓存里还有旧版 pnpm，`corepack pnpm check` 会因脚本内嵌套的 `pnpm` 调用报「current pnpm is v11.7.0」——这是本机双版本 corepack 的拦截，不是仓库问题，改用不带 corepack 的 `pnpm` 即可。

`pnpm-workspace.yaml` 里 `autoInstallPeers: false`：插件的宿主 peer 由 DSH loader 在运行时注入，不在这里装。开着它会把 `@earendil-works/pi-ai` 这类 peer 的整棵依赖树拖进工作区，连带来路不明的 build script，CI 的 `pnpm install --frozen-lockfile` 会以 `ERR_PNPM_IGNORED_BUILDS` 失败，lockfile 也多出近两千行无用条目。需要验证依赖 peer 的运行时行为时，在 DSH profile 里装插件实测；插件测试里依赖 peer 的那一半会自动跳过，CI 只跑不依赖 peer 的结构断言。

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
