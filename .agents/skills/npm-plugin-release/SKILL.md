---
name: npm-plugin-release
description: 在 summerscar/dsh-plugins monorepo 里把插件发到 npm（含首次发布、生命周期 draft→testing→published、Trusted Publishing/OIDC、commit/push/rebase、发布后收录）时使用。凡涉及「开始发布」「发版」「推进生命周期」「first_release」「Publish npm plugins 工作流」「npm 404 / ENEEDAUTH」「新包怎么配 Trusted Publisher」「发布后收录 catalog / 刷新 index.json」都走这个流程，即使作业者没说「skill」二字；只改插件源码/文档、不做 npm 发布的任务不要用它，往第三方市场（awesome-dsh-plugin / dsh-plugin-index）投递请用 dsh-plugin-market-release。
---

# 把本仓插件发布到 npm

本仓发布链路有三段：**① npm 发版（本 skill）→ ② 自建发布站/索引源（catalog + index.json）→ ③ 两个第三方市场（见 `dsh-plugin-market-release`）**。本 skill 管第一段，以及它紧邻的第二段收尾。

先记住一条分界：**本地可逆准备（改清单、同步文档、跑校验）可以主动做；commit、push、触发工作流、npm 发布都需用户明确授权**（根 `AGENTS.md`）。把命令和文件准备好 ≠ 按下发送。

## 三个必须先建立的认知

1. **生命周期是历史，不是开关**：`scripts/plugin-release-states.json` 单向 `draft → testing → published`，`publication` 凭据（version / publishedAt / integrity）永久保留。校验器会拿 `RELEASE_STATE_BASE`（CI 里是 push 前的 commit）对比，禁止倒退、禁止跳过 testing、禁止篡改凭据。所以改清单后必须 `pnpm release:docs` 同步根 README 两张表，再 `pnpm release:check`。
2. **发布器自己会写版本号**：`scripts/publish-npm.mjs` 的 `selectRelease()` 对比 npm 上已有版本，内容变了就 `semver.inc(highest, 'patch')`，并把 `version` + `dshRelease.contentHash` 写回 `package.json`，最后 `commit` 步骤推一条 `chore: record npm releases and plugin market index`。**不要手改版本号**，也不要指望 manifest 里的 `0.1.0` 就是最终发布号。
3. **认证只有 OIDC**：`.github/workflows/npm-publish.yml` 用 `id-token: write` 领取短时凭据，不读 `NPM_TOKEN`；npmjs.com 上必须为**每个包**绑定 Trusted Publisher（用户 `summerscar`、仓库 `dsh-plugins`、workflow `npm-publish.yml`，大小写敏感、带 `.yml`）。配置创建后 **2 天内**要完成一次成功发布，否则过期要删了重建。

## 发布前只读核对（不动 git）

按这个顺序摸清状况，别信交接书的一面之词：

```sh
git status; git log --oneline -8; git fetch origin main; git log --oneline HEAD..origin/main
npm view <完整包名> version            # 404 = 从未发布 = 首次发布路径
pnpm lint                              # 开发中只跑这个（秒级）
pnpm release:check                     # 51 条，含生命周期/文档闸门
pnpm site:test                         # 16 条
pnpm --filter <包名> test              # 行为 + 结构钉子
npm pack --dry-run                     # 在包目录跑，看 files 是否齐、有无漏文件
git diff --check
```

`pnpm check` 是全量闸门，由 husky pre-commit 自动跑；开发阶段别反复手动跑。

## 标准路径（已发布的包，正常更新）

1. 改代码/文档 → `pnpm lint`（随手）、相关 `pnpm --filter ... test`。
2. commit 前 `git fetch origin main`，落后就 `git rebase origin/main`（只有未提交改动时先 commit 再 rebase）。
3. 取得用户授权后 commit → push 前再 fetch 一次 → 需要就再 rebase → `git push origin main`。
4. push 会自动触发 `npm-publish.yml`：`plan`（无 first_release）→ `pnpm check` → `publish` → `site:market` + `commit`（自动把版本和 index.json 写回 main）。
5. 核验 `npm view <包名>@latest version dist.tarball`、`repository`/`homepage`/`license`/`engines`；CI 的 `publish` 会匿名下载归档比对 integrity 后才把状态推进 `published`。

## 首次发布：先解决「鸡生蛋」死锁（本仓最易翻车处）

**npm 的 Trusted Publisher 只能配在「已经存在的包」上，而本仓首发只走 OIDC、没有 token 兜底。** 对一个 `npm view` 返回 404 的新包直接触发 `first_release`，CI 会拿到骗人的 E404 / ENEEDAUTH 并失败，生命周期停在 `testing`。依据：[npm-trust 文档](https://docs.npmjs.com/cli/v11/commands/npm-trust) Prerequisites 明写 "Package must exist"；[Trusted publishers 文档](https://docs.npmjs.com/trusted-publishers) 配置入口是包 Settings；[GitHub 社区讨论 #176761](https://github.com/orgs/community/discussions/176761) 与 [npm/cli#8544](https://github.com/npm/cli/issues/8544) 记录同样的循环依赖。

**动手前先问用户走哪条 break-out**，不要擅自决定（涉及 npm 凭据，作业环境通常没登录，`npm whoami` 多为 401；也别去要/碰用户的 token）：

| 路线 | 做法 | 代价 |
| --- | --- | --- |
| A 占位包 + OIDC（常见） | 用户在**已登录 npm 的机器**发一个占位版本（如 `0.0.0`，可用 [azu/setup-npm-trusted-publish](https://github.com/azu/setup-npm-trusted-publish)）→ 包存在后去 npmjs.com 配 Trusted Publisher → 2 天内触发 `first_release` | 占位版本永久留在 npm 历史；`selectRelease()` 会把首发号 bump 到 `0.0.1` 而非 manifest 的 `0.1.0`；站点/`@latest` 会读到它。需先跟用户对齐版本预期 |
| B 传统认证直发 | 用户在已登录 npm 的机器用真实归档直接发 `0.1.0`，再配 Trusted Publisher，之后回归 CI | 首发不在 CI、无 provenance，且要手工对齐 release 状态/计划 |
| C 先推代码，发布等配置 | 先 commit+push（自动空跑一次 plan、不会真发），用户配好前置后再手动触发 `first_release` | 多一轮，但代码先落库 |

**首次发布的触发方式**（必须显式选择，不会被 push 自动带出）：

```sh
gh workflow run npm-publish.yml --ref main \
  -f first_release="@summerscar/dsh-connect-agentscope-platform"
# 看跑批：gh run list --workflow npm-publish.yml --limit 5
# 跟日志：gh run watch <run-id>
```

`first_release` 填**完整包名**，空格分隔可多个。工作流 `plan --first-release` → `pnpm check` → `publish`（带 `--provenance`、匿名归档核验）→ `site:market` + `commit`。只有归档可匿名下载且 integrity 匹配，`recordVerifiedPublication()` 才把状态写成 `published` 并落 `publication` 凭据。

首发前的本地准备（可逆，可主动做）：

1. `scripts/plugin-release-states.json`：该包 `state: draft → testing`，重写中英 `reason`（指向「首次交付验收中、待授权发布」）。
2. `pnpm release:docs` 生成根 README 两张表；`pnpm release:check` + `pnpm lint` + `git diff --check` 复核。
3. 确认 `package.json`：`engines.dsh` 开放下界、`repository` 与 GitHub 大小写一致、`homepage` 指站点详情页、`files` 列全新增文件、`screenshots.json` 别是空数组 `[]`（**是数组不是对象**，写成 `{}` 第三方市场读不出来）。
4. **先确认 Trusted Publisher 前置已就绪**，再谈 commit/push/触发，别白跑一次失败记录。

## 发布成功后：收录与收尾

npm 上有 `latest` 之后才做（规则见 `site/AGENTS.md`）：

1. `site/catalog.json` 加条目：`slug` 用去作用域去 `dsh-` 前缀的小写连字符、`summary`/`title` 双语、`readme.zh`/`readme.en` 填包内相对路径、`directory` 填 `plugins/<包目录>`。
2. 同步根 README 插件表格（一处简介改了，`package.json description`、`locale/*/meta`、`catalog summary`、根 README、包内 README 几处一起改）。
3. 跑 `pnpm site:market` 刷新根目录 `index.json`，`pnpm site:test` + `pnpm site:market:check` 复核。**详情页缺图补的是「包内 `assets/` + README 中英各嵌一张 `<img>`」，不是 `screenshots.json`**——站点只渲染 README 里的图；`screenshots.json`（数组格式）只给第三方市场用。
4. 状态推进 `published` 由发布器 `commit` 步骤自动完成，**不要手改** `publication` 凭据。
5. 第三方市场收录交给 `dsh-plugin-market-release`。

## 提交/推送的同步纪律

本仓发布工作流会在作业期间基于同一祖先推一条 `chore: record npm releases and plugin market index`（推高 `package.json` 版本、`dshRelease.contentHash`、刷新 `index.json`），不先同步就 push 必然 non-fast-forward 被拒。

- commit 前与 push 前**各 `git fetch origin main`**；远端领先用 `git rebase origin/main`（只改写本地未推送历史），禁止盲目 `git pull`（会生成无意义 merge commit）、禁止 `--force`。
- `index.json` 是发布工作流拥有的生成物：`.husky/pre-commit` 在满足「本地落后 + 本次没动过 index.json」时会自动 `git checkout origin/main -- index.json` 采用远端副本。若 `pnpm check` 报它过期，重跑 `pnpm site:market`。
- `git add` 用**精确文件列表**（如 `git add -- README.md README.zh-CN.md scripts/plugin-release-states.json plugins/.../...`），别用 `git add -A` 把 `.agents/`、`.scratch/`、临时产物裹进去。

## 常见翻车点

- 新包没配 Trusted Publisher 就触发首发 → E404/ENEEDAUTH，见上节。
- 改了清单忘了 `pnpm release:docs` → `release:check` 的 `--check-docs` 直接红。
- 手改 `version` 或 `dshRelease.contentHash` → 计划 preflight 校验 sourceHash 不匹配。
- 新增包内文件没列进 `package.json` 的 `files`（需要外部解析时还有 `exports`）→ `npm pack` 漏文件，站点构建读不到。
- `screenshots.json` 写成 `{}` → 格式错（该是数组），第三方市场读不出截图；**但站点详情页有没有图跟它无关**，站点只认 README 里的 `<img>`。
- 只改 `site/`、根 README 或未打包测试时**保持当前发布状态**，不要顺手推进生命周期。
- 首发后忘了收录 catalog / 刷 `index.json` → 站点和 market 索引停留在旧数据。
- **用 `--no-verify` 跳过 pre-commit 钩子** → 钩子根本不启动，reflog / 提交信息 / bash history **都不留痕**，事后查不出来不等于没发生。`pnpm check` 正是为防止「本地过了、仓库没过」。嫌慢该改钩子或分工，不是绕过；万不得已要跳（如钩子自身有 bug），**必须在提交信息里写明原因和事后补跑结果**。
- **以为 `engines.dsh` 的预发布范围会漏掉下一个 rc** → 不会。DSH 用 `includePrerelease: true` 判定（`dsh-app-boot/lib/index.js` 的 `unmetRequirements()`），`0.2.3-rc.1` / `0.3.0-rc.1` 都放行；而 pnpm/npm **根本不校验** `engines.dsh` 这个自定义字段。别为「可能会漏」单独发一版。真正要留意的是反过来的风险：**manifest 有 `engines.dsh` 时 peer 完全不参与判定**，哪天有人把它删了，peer 立刻接手，那些开放下界的预发布范围才开始漏版本——删它属于破坏性改动，不是清理。
- **从会话日志读用量/成败时读错字段位置** → `assistant/message` 的 token 用量在 **`data.usage`**，`data.message.usage` 恒为 `undefined`；`tool/result` **没有 `data.ok` 字段**，成败看 **`data.message.isError`**，HTTP 细节在 `data.meta`（`statusCode` / `truncated` / `sources` / `answer`）。拿 `undefined` 当「产品没记录」之前，先 `Object.keys(data)` 把容器键打出来。
- **只验 adapter 就宣称「链路通了」** → 脚本直连 `pi-adapter` 只能证明「凭据取得 → 模型调起 → 流式返回」，证明不了界面路径（切模型后路由到哪个 provider、UI 取凭据走哪条路、会话是否落盘、工具调用能否回填）。两条路径要分别验，结论也分别写。

## 授权边界

改清单、同步文档、跑校验、准备命令/正文都属本地操作，可主动做。**commit、push、触发 `npm-publish.yml`（含 `first_release`）、任何 npm 发布都需用户本轮明确授权**；`gh workflow run` 这类对外写操作同理。作业环境通常没登录 npm，涉及凭据的动作交给用户在自己机器上做，别索取或回显 token。

## 本仓现成入口

| 入口 | 作用 |
| --- | --- |
| `scripts/plugin-release-states.json` | 生命周期清单（唯一手工维护的发布状态） |
| `scripts/publish-npm.mjs` | `plan [--first-release NAME]` / `publish` / `commit` |
| `.github/workflows/npm-publish.yml` | push 自动计划 + `workflow_dispatch` 的 `first_release` |
| `pnpm release:docs` / `release:check` / `release:status` | 文档同步、闸门、只读诊断 |
| `pnpm site:market` / `site:market:check` | 刷新/核对根目录 `index.json` |
| `RELEASING.zh-CN.md` / `RELEASING.md` | 生命周期与 OIDC 的正式规则 |

更细的命令与前置清单见 `references/commands.md`；几条可复用的验收提示见 `evals/evals.json`。
