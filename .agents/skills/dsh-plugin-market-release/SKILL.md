---
name: dsh-plugin-market-release
description: 把本仓（summerscar/dsh-plugins）的插件发布到两个社区市场——awesome-dsh-plugin（PR）与 dsh-plugin-index（Issue）——并保持 npm 包 meta、条目地址、版本号三方一致时使用。凡涉及「收录申请」「提交市场」「上架」「更新市场条目」「插件地址变了要改市场」「PR #xxxxx 被打回要改」都走这个流程，即使作业者没说「市场」二字；只改仓库内文档/代码、不投递外部市场的任务不要用它。
---

# 把插件发布到两个 DSH 社区市场

本仓的插件发布链路有三段：npm 发版（Trusted Publishing）→ 自建发布站/索引源 → 两个第三方市场收录。本 skill 只管**第三段**，以及在它之前必须核对的一致性。

市场是别人审的地方，规则由对方定、且会变。**动手前先读对方仓库当下的 `contributing.md` / 模板文件**，不要把本 skill 里的字段规则当成永远正确——它们记录的是「截至 2026-11 实测有效」的形态与踩坑，不是合同。

## 两个市场，两种投递形态

| 市场 | 投递方式 | 落地形态 | 备注 |
| --- | --- | --- | --- |
| `awesome-dsh-plugin/awesome-dsh-plugin` | Fork + PR | `data/plugins/<owner>__<repo>.yml` 一个文件 | 审核后会 merge；README 由脚本生成，**禁止手改** |
| `polang233/dsh-plugin-index` | Issue（表单模板） | 维护者人工录入，无仓库文件 | 维护者可能先「暂缓」再复核，属正常流程 |

两者**独立审核、独立节奏**，可以一个已收录、另一个还在排队，不必同步等待。

## 开始前：先核对四件事

市场条目里的地址与 meta 一旦写错，审核者会退回或收进一个指向废仓库的条目，所以先把这些核准：

1. **仓库与子目录**：`gh repo view <owner>/<repo> --json nameWithOwner,url` 确认真实地址；monorepo 要记下插件的相对路径（本仓是 `plugins/<package-slug>/`）。
2. **npm 上最新版本与 meta**：npm 的信息不在 GitHub 上，要查 registry：
   ```sh
   curl -s https://registry.npmjs.org/<url-encoded-package> \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=j["dist-tags"].latest,m=j.versions[v];console.log(v,m.repository,m.homepage,m.license,JSON.stringify(m.engines))})'
   ```
   重点看 `repository` 是否指回**要被收录的那个仓库**（带 `directory` 更好）、`license`、`engines.dsh` 下界。
3. **包内是否可安装**：`dsh.bundle.patch` 必须存在（只有 `dsh.client` 会被多个市场判为不可安装）。monorepo 里根或子包声明都算，但对方 CI 会去 `plugins/` 等子目录找。
4. **截图与图标**（可选但影响展示）：`screenshots.json` 放在 `package.json` 旁边、列出包内相对路径；`icon` 必须是 GitHub 托管的位图（`raw.githubusercontent.com` 等），第三方图床会被拒。

## 市场一：awesome-dsh-plugin（PR）

### 文件名与字段：monorepo 必须换形态

单包与 monorepo 子包的条目形态不同，**照抄单包写法会被 CI 打回**：

```yaml
# 单包仓库
url: https://github.com/owner/repo
name: owner/repo
# → 文件名 data/plugins/owner__repo.yml
```

```yaml
# monorepo 子包（本仓就是这种）
url: https://github.com/owner/repo/tree/main/packages/my-plugin
name: owner/repo#my-plugin          # # 之后是自由标签
# → 文件名 data/plugins/owner__repo--packages-my-plugin.yml
```

文件名不是手算的：对方用 `slugFor(url)` 推导——取 `owner/repo` 拼 `owner__repo`，`/tree/<branch>/<path>` 部分把 `/` 换成 `-` 接在 `--` 后面。写错文件名 CI 会直接说「filename must match the url」。**不确定就用下面这段跑一遍**：

```sh
node -e '
const url="https://github.com/summerscar/dsh-plugins/tree/main/plugins/dsh-mnemon-sync";
const p=url.replace(/^https:\/\/github\.com\//,"").replace(/\/+$/,"");
const repo=p.split("/").slice(0,2).join("/");
const sub=p.includes("/tree/")?p.split("/tree/")[1].replace(/^[^/]+\//,""):null;
const base=repo.replaceAll("/","__");
console.log((sub?base+"--"+sub.replaceAll("/","-"):base)+".yml");
'
```

几条会被 CI 或人工退回的硬规则：
- 一个 PR **最多 3 条**条目；改自己的条目时**只动自己那一条**。
- `description.en` 必填；**含 `: ` 必须加引号**（否则 YAML 当成嵌套键）；描述只陈述可验证行为，写数字就要真对得上代码。
- 仓库需含**真实可用代码**、创建满 **1 天**、带 `dsh-plugin` topic。
- `name` 写成 `owner/repo` 形式时，`#` 前的部分必须与 `url` 的仓库一致；只用裸显示名（不带 `/`）则不校验。
- **不要手改 README**，也不要往条目里加 `npm:` 之类没人读的字段（会被拒）。

### 提交流程

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false   # 已有 fork 可跳过
git clone https://github.com/<you>/awesome-dsh-plugin && cd awesome-dsh-plugin
git checkout -b add-<owner>-<slug>
# 写 data/plugins/<slugFor 推导的文件名>.yml
git add data/plugins && git commit -m 'catalog: add <owner>/<repo> (<subpath>)'
git push -u origin add-<owner>-<slug>
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title 'catalog: add <owner>/<repo> (<subpath>)' --body-file /tmp/pr-body.md
```

PR 正文写清：仓库地址（带子目录）、npm 包名与 latest、只有这一个新增文件、以及对着 `contributing.md` 的 checklist（`dsh.bundle` 位置、仓库年龄、topic、描述引号、monorepo 条目形态、`repository` 指回）。

### 返修与重命名型改动

维护者要说改什么会打 `held: author` 标签。操作要点：
- **在同一个分支上 push**，然后留**一条**评论说明改了什么；不要反复推、不要催。
- 仓库改名/搬目录时，条目要**换文件名**（旧文件删、新文件建），于是 PR 变成「1 删 1 增」——条目数仍按 1 计，但正文里「adds exactly one file」的表述要同步改。
- 删文件用 `gh api -X DELETE repos/<fork>/contents/<path> -f message=... -f branch=...`，建文件用 `gh api -X PUT ... -f content=$(base64 -w0 file)`。
- 已合并的 PR 不要再改；改名后要更新条目就**另开一个新 PR**（同样只动自己那一条）。

## 市场二：dsh-plugin-index（Issue）

用表单模板发 issue，字段以 `.github/ISSUE_TEMPLATE/plugin-add.yml` 为准（会变，先读）：

```sh
gh issue create --repo polang233/dsh-plugin-index \
  --title '[plugin-add] <package-name>' \
  --body-file /tmp/issue-body.md
```

正文至少要覆盖模板要求的四块：插件地址（monorepo 注明子目录相对路径）、简短说明、截图（可选）、补充信息（npm 版本、已测 DSH 版本与声明范围、平台、许可证、`dsh.bundle` 是否随包、认证接入情况、仓库 topics）。

现成的骨架在 `references/issue-body-template.md`，复制改值即可；维护者回复「暂缓」时的处理方式也写在那份文件里。

`title` 保持 `[plugin-add] <package>`——包名不变时**不要因为它换了仓库就改标题**，维护者靠包名检索。

### 维护者可能「暂缓」

实测过一次：维护者先评论「0.1.8 暂缓：<具体缺陷>，修复并发布后再复核」。这不是拒绝，处理方式是：
1. 真去修那个缺陷并发版；
2. **在原 issue 里回复**修了什么、怎么验证的（要点给结论，不要贴大段日志）；
3. 等维护者复核。复核通过会评论「x.y.z 已收录」并关 issue。

## 一致性：三处必须对得上

市场条目、npm 包 meta、仓库内文档任何一处改动，都要回头核对另外两处：

| 位置 | 该与什么一致 |
| --- | --- |
| npm `repository`（含 `directory`） | 市场条目 `url` 指向的仓库/子目录；这是市场判断「包是否认领该仓库」的依据 |
| npm `license` / `engines.dsh` | PR 正文与 issue 正文里的许可证、兼容范围表述 |
| `site/catalog.json` 的 `summary` / `title` | 包内 `locale/*.json` 的 `meta`、`package.json` 的 `dsh.catalog`、根 README 表格 |

改完用只读方式复核，别靠记忆：

```sh
gh pr view <n> --repo awesome-dsh-plugin/awesome-dsh-plugin --json state,title,files
gh api repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins/<file>.yml --jq .content | base64 -d
gh issue view <n> --repo polang233/dsh-plugin-index --json state,body,comments
```

## 发新版本之后

市场条目里写死的版本号会过期。两种处理：
- 条目/正文里写「latest `<version>`」的，发版后**回去更新**（PR 未合并就改分支上那个文件 + 改正文；issue 已关闭就留一条评论说明新版本）；
- 更省事的做法是正文只写包名、版本以 npm 为准——但审核者往往想看到具体版本，权衡着来。

## 常见退回原因（对着自查）

- 文件名与 `url` 推导结果不一致（monorepo 最常见）。
- 描述里带 `: ` 没加引号，YAML 解析失败。
- 只有 `dsh.client` 没有 `dsh.bundle`，判为不可安装。
- 仓库太新（< 1 天）或没有 `dsh-plugin` topic。
- 描述夸大了能力，与代码对不上。
- PR 碰了别人的条目或手改了生成的 README。
- npm 包的 `repository` 没指回被收录的仓库，导致市场关联不上包。

### radar 这类市场：分类是两套，别混

- **`PLUGINS.md` 的文件分区 ≠ PR 正文的分类字段**。前者是文件里「🔌 单插件 / 🧰 插件集」这种排版分区，后者按 **taxonomy v2** 填（如 `🛠 基建部署`、`🧠 记忆增强`）。两套各管各的，填错一个不影响另一个。
- **`classify.py` 的输出要按 `CATALOGING.md` 复核**。它是关键词撞出来的，会撞偏：本仓一个「带面板的模型接入插件」被撞成「Web UI 增强」，而 `CATALOGING.md` 边界规则第 4 条明写「**MCP/模型接入**：接入外部模型或 MCP 服务 → 基建部署」。面板只是附属功能，不改变归属。
- **`maintainerCanModify` 建 fork 时默认就是 `true`**，不用再跑 PATCH 去开；先查一次实际值，别多做一步。
- 标题按对方模板来（如 `docs: 登记 <插件名>`），中文标题不合规范。

## 授权边界

Fork、开 PR、发 issue、回评论都是**对外的写操作**。按本仓 AGENTS.md 的规矩：提交、推送、发布、投递市场都要先取得用户明确授权。可以替用户把文件和正文准备好、把命令列出来，但**不要自己按下发送**，除非用户这一轮明确说了去投/去更新。

## 本仓现成的入口

### 生成 awesome 条目（含一致性自查）

在本仓根目录跑，文件名与 YAML 一次给全，并核对 npm 上 `repository` 是否认回本仓：

```sh
node .agents/skills/dsh-plugin-market-release/scripts/entry.mjs \
  --repo https://github.com/summerscar/dsh-plugins \
  --subdir plugins/dsh-mnemon-sync \
  --package @summerscar/dsh-mnemon-sync \
  --category memory \
  --out /tmp/entry.yml
```

退出码 `2` 表示 npm 的 `repository` 没认回本仓——先去修 `package.json` 再投递，否则市场关联不上包。

### 两个市场目前的登记点

| 市场 | 对象 | 说明 |
| --- | --- | --- |
| awesome-dsh-plugin | 已有条目 `data/plugins/summerscar__dsh-plugins--plugins-dsh-mnemon-sync.yml` | 首次收录的 PR 已合并；之后再改描述/分类，另开 PR 只动这一个文件 |
| dsh-plugin-index | issue 已关闭（已收录） | 版本号变化时在 issue 里补一条评论即可，不用重开 |

新增插件时按上面的投递形态各来一次，两者节奏独立，不必等对方一起。
