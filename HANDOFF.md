# Handoff：dsh-mnemon-sync 的「同步备份」标签页不显示

> 给另一台 DSH 的排查用。本文只描述已在本机验证过的机制与事实，未验证的部分明确标出。
> 插件版本：**0.1.2**（npm `latest`，2026-11-09 已上架）。
> 安装方式：`dsh plugin --profile <name> add @summerscar/dsh-mnemon-sync`。

---

## 1. 结论先行（最可能的原因）

标签页的显示有一条**硬链路**，任一环断了 tab 就不出现：

```
Host 的 mnemonMemory 服务可用
  → 插件 Host 侧调用 installContributions 注册一个 Source
  → 该 Source 进入 managementCatalog → 出现在 sourceCatalog.sources
  → 浏览器端 sourceInstances 里有 sourceTypeId === 'mnemon-sync'
  → visibleSourcePages 才保留 mnemon-sync/sync 这个页面
  → 渲染成 tab
```

**最可能的三个原因，按概率排序：**

1. **装完没有重启 DSH。** Host 侧的 Source 注册走 `ctx.effect`，client bundle 也在启动时加载；两者都要重启才生效。这是最常见的原因。
2. **bundle 没被 profile 激活**（装了包但 `dsh.profile.bundles` 里没有 `@summerscar/dsh-mnemon-sync`，或 patch 层未应用）。此时 Host 插件根本不运行。
3. **`dsh-mnemon` 版本低于 0.5.40**，或该服务没起来（缺 `mnemonMemory` 服务）。插件的 `peerDependencies` 要求 `dsh-mnemon >= 0.5.40`，但它是 **optional peer**，缺了不会报错、只会静默不注册页面——很容易被忽略。

---

## 2. 请在那台机器依次执行

### 2.1 确认装的是哪个版本、bundle 有没有启用

```sh
# 版本
dsh plugin --profile <name> list | grep -i mnemon-sync
npm view @summerscar/dsh-mnemon-sync version

# profile 里 bundle 是否列进去了（关键）
grep -n "dsh-mnemon-sync" "$DSH_PROFILE_DIR/package.json"
# 期望：dependencies 里有一行，且 dsh.profile.bundles 数组里也有 "@summerscar/dsh-mnemon-sync"

# dsh-mnemon 版本（必须 >= 0.5.40）
node -e "console.log(require('$DSH_PROFILE_DIR/node_modules/dsh-mnemon/package.json').version)"
```

如果 `bundles` 里没有，重新装：

```sh
dsh plugin --profile <name> add @summerscar/dsh-mnemon-sync@0.1.2
```

### 2.2 重启 DSH（必须）

装完后重启。重启后等约 10 秒，再看标签页。

### 2.3 重启后仍不显示，查 Host 侧日志

```sh
# 看插件有没有报错（本机用 docker，按你的部署方式替换）
docker logs <dsh-container> --since 10m 2>&1 | grep -i "mnemon-sync"
```

关注两类输出：

- `mnemon-sync: dsh-mnemon extension SDK not found; the sync tab stays hidden`
  → 说明 `mnemonMemory` 服务在但 SDK 解析失败。
- `mnemon-sync: could not register the sync source ...`
  → 把完整错误贴回来。

**如果这条日志都没有**，说明 Host 插件压根没运行，回到 2.1 查 bundle。

### 2.4 查 client bundle 有没有下发

```sh
curl -s http://127.0.0.1:3080/ | grep -o "@summerscar/dsh-mnemon-sync/client.js[^\"]*"
```

有输出说明浏览器端会加载。然后强刷页面（Ctrl+Shift+R）。

### 2.5 查槽位注册

用 `cordis_inspect_query`（platform=client, provider=Slots, method=listSubTree, `{"root":"mnemon.source.page"}`），看 occupants 里有没有：

```
id: "mnemon-sync/sync", active: true
```

- **有** → 页面注册成功，但 tab 被 `visibleSourcePages` 过滤掉了 → 说明 `sourceInstances` 里没有 `mnemon-sync` 类型，回到 2.3 查 Host 侧 Source 是否真的进了 catalog。
- **没有** → client 插件没加载或注册失败，查 `dsh-mnemon/client` 是否可用。

---

## 3. 已验证的机制细节（供对照，别重复试）

这些是本机实测 + 读 dsh-mnemon 0.5.x 源码确认的，不需要再验证：

| 问题 | 结论 |
|---|---|
| 需要手动加 `memoryTopology.layers.mnemon-sync` 吗？ | **不需要**。`allowsParticipation()` 在 layer 缺省时返回 `true`。本机 profile 里那一层是本鱼排查时手动加的，不是必需项。 |
| `instanceId` 必须等于 Loader Entry id 吗？ | **不需要**。`installContributions` 只把它当 provenance 标识（`source:<instanceId>`），不校验与 Entry id 一致。 |
| 为什么借用 `memory-spaces` 类型不行？ | 上游按 `sourceTypeId` 前缀高亮 tab，借用会导致两个 tab 同时点亮。所以插件用了独立类型 `mnemon-sync`。 |
| 为什么 Source 里必须有 `management` 描述符？ | `managementCatalog()` 对没有 `management` 的 Source 返回 `null`，它就不会进 `sourceCatalog.sources`，页面被判定为「已开启但未运行」。插件已声明。 |
| `dsh-mnemon` 缺失会怎样？ | 插件仍能备份（Host 接口可用），但**页面不显示**。peer 是 optional 的，不会报错。 |
| npm 安装后 SDK 解析 | 插件用 `createRequire(import.meta.url)` 主路径 + `DSH_PROFILE_DIR` 回退，npm 安装和 link 安装两种形态都覆盖过。 |

---

## 4. 本机已知的「正常」状态（对照用）

```
包名:        @summerscar/dsh-mnemon-sync@0.1.2
profile:     dependencies + dsh.profile.bundles 两处都有
bundle patch: - insert: [{ id: mnemon-sync, name: '@summerscar/dsh-mnemon-sync' }]
槽位:        mnemon-sync/sync, order 750, active true
页面:        记忆系统 → 记忆空间那排 tab 后面的「同步备份」
```

---

## 5. 如果以上都正常还是不显示

把下面几项贴回来，本鱼继续分析：

1. 2.1～2.5 每一步的实际输出
2. `docker logs` 里 mnemon-sync 相关全部输出（没有就写「无」）
3. `cordis_inspect_query` 的完整 occupants 列表
4. 那台机器的 `dsh-mnemon` 版本、DSH 版本（`dsh --version`）

---

## 附：一个容易踩的坑（本机发生过，仅作提醒）

插件的设置接口回显密钥时只给掩码 `••••••••`。**0.1.0** 有个 bug：`/run` 接口把页面草稿存盘时没做掩码还原，会把 `••••••••` 当成真实密码写进配置，导致「配置看着对、备份却一直 401」。
**0.1.1 已修复**（`restoreMaskedSecrets`）。所以务必装 **0.1.1 或更高**；如果那台机器装的是 0.1.0，请升级：

```sh
dsh plugin --profile <name> add @summerscar/dsh-mnemon-sync@0.1.2
```
