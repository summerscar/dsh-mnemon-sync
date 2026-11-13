# 发布命令与前置清单（细版）

`SKILL.md` 是流程与判断，这份是可复制的命令与逐项核对。所有路径相对仓库根 `/data/dsh/home/default/dsh-plugins`。

## 1. 只读基线（每次开工第一件事）

```sh
PKG="@summerscar/dsh-connect-agentscope-platform"   # 换成目标包
SLUG="dsh-connect-agentscope-platform"              # 包目录名

git status
git log --oneline -8
git fetch origin main
echo "落后提交："; git log --oneline HEAD..origin/main
echo "领先提交："; git log --oneline origin/main..HEAD
npm view "$PKG" version                 # 404 = 首次发布
pnpm release:status                    # 当前生命周期与是否可自动发布
pnpm lint
pnpm release:check
pnpm site:test
pnpm --filter "$PKG" test
(cd "plugins/$SLUG" && npm pack --dry-run --cache ../../.npm-cache)
git diff --check
```

基线期望（已发布包正常态、新包首次发布态会不同）：`lint` 绿、`release:check` 51 pass、`site:test` 16 pass、插件测试全绿（宿主 peer 未装时固定 1 skip 属设计）、pack 文件数与 `files` 一致。

## 2. 状态推进（draft → testing，仅首次发布前）

编辑 `scripts/plugin-release-states.json` 里该包条目：

```json
{
  "name": "@summerscar/dsh-connect-agentscope-platform",
  "state": "testing",
  "reason": {
    "zh": "首次交付进入检查与验收：……已完成，测试、打包与发布校验已通过，等待明确授权后做首次发布。",
    "en": "First delivery is in check and acceptance: ...; awaiting explicit approval for the first publication."
  }
}
```

然后：

```sh
pnpm release:docs        # 生成根 README.md / README.zh-CN.md 的两张表
pnpm release:check       # --check-docs 会比对工作树与 HEAD
pnpm lint
git diff --check
git diff -- README.md README.zh-CN.md scripts/plugin-release-states.json
```

注意：`validateLifecycleTransition()` 禁止 `draft → published` 跳级、禁止倒退、禁止改动 `publication` 三字段；`reason.zh`/`reason.en` 都不能为空。

## 3. Trusted Publisher 前置（首次发布必查）

```sh
npm view "$PKG" version                 # 404 说明包不存在 → 死锁，见下
npm whoami                              # 作业环境常为 401，别纠结
npm --version                           # 需 ≥ 11.5.1；npm trust 需 ≥ 11.15.0
```

npmjs.com 网页配置（**每个包单独配，字段大小写敏感**）：

1. 进入包的 Settings → Trusted Publisher → GitHub Actions。
2. Organization or user = `summerscar`；Repository = `dsh-plugins`；Workflow filename = `npm-publish.yml`（只填文件名、带 `.yml`）。
3. Environment name 留空（本仓没用 GitHub environments）。
4. Allowed actions：配置创建于 2026-09-03 之后默认只允许 `npm stage publish`，**必须勾上允许 `npm publish`**，否则本仓 `npm publish --provenance` 会被拒。
5. **2 天内**完成一次成功发布验证配置，过期要删了重建。
6. 可选加固：Settings → Publishing access → "Require two-factor authentication and disallow tokens"。

依据：[Trusted publishers](https://docs.npmjs.com/trusted-publishers)、[npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)、[azu/setup-npm-trusted-publish](https://github.com/azu/setup-npm-trusted-publish)。

### 包不存在的 break-out（要用户自己在其已登录 npm 的机器上做）

```sh
# 路线 A：占位包（默认 0.0.0）。工具会明确标注"仅用于 OIDC 配置、无代码、勿依赖"。
npx setup-npm-trusted-publish "$PKG" --access public
# 然后去 https://www.npmjs.com/package/<pkg>/access 配 Trusted Publisher
# 配好后 2 天内触发 first_release（见 §5）
```

占位包对版本的连锁影响（务必先跟用户讲清）：`selectRelease()` 发现 npm 上已有 `0.0.0` 且 `0.1.0 > 0.0.0`，但 `highest=0.0.0` 时会 `semver.inc('0.0.0','patch')` 得到 **`0.0.1`**，不是 manifest 的 `0.1.0`。占位版本还会永久留在 `latest` 历史里、被 `npm view @latest` 与站点构建读到。若用户要干净 `0.1.0`，走路线 B（传统认证直发真实归档）或先把 manifest 版本对齐预期。

作业环境没登录 npm（`npm whoami` 401）时**不要试图找 token**，交给用户；也别把 `.npmrc` 内容回显出来。

## 4. 提交与推送（需用户明确授权）

```sh
git fetch origin main
# 若 HEAD..origin/main 非空：先 rebase（工作区要干净；只有未提交改动就先 commit 再 rebase）
git rebase origin/main
git diff --stat HEAD..origin/main       # 看清远端多了什么，多半 package.json + index.json

# 精确暂存，别用 -A
git add -- \
  README.md README.zh-CN.md \
  scripts/plugin-release-states.json \
  "plugins/$SLUG/..."                 # 把实际改动/新增文件逐项列出
git commit -m "feat(<slug>): ..."      # husky pre-commit 会自动跑 pnpm check

git fetch origin main                  # push 前再同步一次
# 远端又前进就再 git rebase origin/main
pnpm check                             # 手动全量闸门（明确需要时才跑）
git push origin main
```

`index.json` 由发布工作流的 `commit` 步骤写回；若 `site:market:check` 报过期，`pnpm site:market` 重生成即可。pre-commit 钩子在本地落后且本次没动 `index.json` 时会自动采用 `origin/main` 的副本。

GitHub 操作优先 `gh` CLI（用户 2026-11-10 明确要求）：

```sh
gh auth status
gh run list --workflow npm-publish.yml --limit 5
```

## 5. 触发首次发布（需用户明确授权）

```sh
gh workflow run npm-publish.yml --ref main \
  -f first_release="@summerscar/dsh-connect-agentscope-platform"
# 多个包用空格分隔：-f first_release="pkgA pkgB"
RUN_ID=$(gh run list --workflow npm-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID"
```

工作流内部顺序（`npm-publish.yml`）：`plan --first-release <pkgs>` → `pnpm check` → `publish` → `pnpm site:market` + `node scripts/publish-npm.mjs commit`。`publish` 会 `npm publish <archive> --provenance --tag latest`，再匿名下载归档比对 integrity；只有全部通过，`recordVerifiedPublication()` 才把状态写成 `published` 并落 `publication` 凭据。

`push` 到 main 也会自动触发一次 `plan`（不带 `first_release`，对 testing 包不会真发），别把它误当成发布成功。

## 6. 发布后核验与收录

```sh
npm view "$PKG" version dist.tarball
npm view "$PKG"@latest repository homepage license engines --json
# integrity 由 CI 核验；这里人工看一眼 meta 是否指回本仓
```

然后（npm 有 `latest` 之后才做）：

1. `site/catalog.json` 增加 `plugins[]` 条目：`slug`（去作用域去 `dsh-` 前缀）、`package`、`category`（须在 `categories` 里）、`kind`、`title`/`summary` 双语、`readme.zh`/`readme.en` 包内相对路径、`repository`、`directory`。
2. 一处简介改了，同步：`package.json description`、`locale/zh.json`+`en.json` 的 `meta`、`catalog.json summary`、根 README 插件表格、包内双语 README。
3. 站点详情页的截图来自 **README 里的 `<img>`**（图片放包内 `assets/` 并在 README 嵌入），**站点不读 `screenshots.json`**。`screenshots.json` 是给第三方市场用的清单，**格式是数组**（如 `["assets/shot.png"]`），别写成 `{}`——写成对象没人读得出来。
4. ```sh
   pnpm site:market          # 刷新根目录 index.json
   pnpm site:test
   pnpm site:market:check
   pnpm lint
   git diff --check
   ```
5. 生命周期 `published` 与 `publication` 凭据由发布器 commit 步骤写回，**别手改**。
6. 第三方市场收录交给 `dsh-plugin-market-release`（awesome-dsh-plugin PR + dsh-plugin-index Issue）。

## 7. 常见失败对照

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| CI 首发 `E404` / `ENEEDAUTH` | 包不存在、Trusted Publisher 没配或没勾 `npm publish` | 按 §3 break-out，别重复触发 |
| `release:check` 报 "release states are outdated" | 改清单没跑 `pnpm release:docs` | 跑 `pnpm release:docs` |
| preflight 报 "Package changed after planning" | 手改了 version/contentHash 或计划后改了源码 | 别手改，让发布器写；重跑 plan |
| `npm pack` 少了文件 | 新增文件没进 `package.json files`（外部解析还要 `exports`） | 补声明再 `pnpm pack:check` |
| push 被拒 non-fast-forward | 发布工作流并发推了 chore 提交 | `git fetch` + `git rebase origin/main` 后再 push，禁止 `--force` |
| 站点首页变 README、`/assets/site.css` 404 | Pages Source 被设成 Deploy from a branch | 设回 GitHub Actions（见 `site/AGENTS.md`） |
