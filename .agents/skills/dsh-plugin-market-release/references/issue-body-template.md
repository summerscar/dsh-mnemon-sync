# dsh-plugin-index 收录申请正文骨架

发给 `polang233/dsh-plugin-index` 的 issue 用。字段以对方 `.github/ISSUE_TEMPLATE/plugin-add.yml` 为准（会变，发前先看一眼）。标题保持 `[plugin-add] <包名>`——包名不变时不要因为换仓库就改标题，维护者靠包名检索。

把 `<…>` 换成真实值，删掉用不到的行。**版本号与兼容范围要跟 npm 现状一致**，别凭记忆写。

```markdown
### 插件地址 / Plugin link

@<scope>/<package>
源码：<repo-url>（<若为 monorepo：插件位于 `plugins/<slug>/`；仓库更名过就注明曾用名与「同一仓库、历史与 id 保留」>）

### 简短说明 / Summary

<一句话说清用途：做什么、给谁用、关键机制。中文或英文均可。>

### 补充信息 / Additional details

- npm：https://www.npmjs.com/package/<package> （latest `<version>`；`repository` 已指向 <repo> 并带 `directory: plugins/<slug>`）
- 已测试 DSH 版本：<version>（声明范围 `<engines.dsh>`，`engines.dsh` 与 `dsh.compatibility.dsh` 均为开放下界，无上界）
- 平台：<平台与 profile，如 Linux x64，Web / desktop profile>
- 许可证：<license>（根与包内 LICENSE）；<若历史版本不同，注明「x.y.z 及之前仍为 <旧>，历史 tarball 不变」>
- <发版方式，如：通过 npm Trusted Publishing（GitHub Actions OIDC）发布，带 provenance 证明>
- `dsh.bundle.patch` 已声明（<子包路径>/cordis.patch.yml），补丁与全部入口文件均在发布包内
- <安全相关：HTTP 接口是否接入宿主认证等>
- 仓库 topics：<topics>

### 截图（可选）

<拖入 1–6 张真实使用截图并配一句说明；不要 Logo/装饰图，记得遮盖密钥与个人信息>
```

## 维护者回复「暂缓」时

不是拒绝，是「先修这个再来」。在**同一个 issue** 里回复，三句话给结论：修的是什么、怎么验证的、新版本号。不要贴大段日志，不要新开 issue。

## 已收录之后

issue 会被关闭。之后再发版导致正文里的版本号过期时，**留一条评论**说明新版本即可，不用重开 issue。
