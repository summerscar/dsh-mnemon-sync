# plugins/ 专项规则

在 `plugins/**` 下开发插件时适用；通用规则见根目录 `AGENTS.md`。

## 官方包依赖约定

`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 由宿主运行时提供，版本范围只写开放下界（写精确版本或 `<0.2.0` 上界会让 loader 命中 pnpm 装进 profile 的旧拷贝，导致版本检查失败并停用插件）。

- **宿主内置的包**：写进 `peerDependencies` 开放下界 + `peerDependenciesMeta` 标 `optional: true`（避免 auto-install-peers 安装物理副本）。这些包由宿主 loader 在运行时注入，插件源码里用动态 `import()` 并提供解析失败时的降级路径。
- **宿主未内置的包**：放入 `dependencies`，同样写开放下界。
- **`devDependencies` 按实际需要决定，不是硬性要求**：只有真正存在本地 typecheck / 构建步骤、需要物理安装一份精确版本时才写。纯 JS 零构建插件（无 `typecheck`、无 build 脚本）里这些宿主包本地根本解析不到，写了只是死声明，会误导人以为 `pnpm install` 能装上。
- `engines.dsh` 同样只写开放下界。

本仓的 `dsh-connect-agentscope-platform` 即属于零构建纯 JS 插件：只声明可选 peer，无 `devDependencies`；`pi-adapter.js` 动态导入宿主 peer，解析失败只撤下模型路由并记日志（`engines.dsh` 已指向第一个自带该 peer 的宿主版本）。新增包内文件必须同步列入 `package.json` 的 `files`（以及需要被外部解析时的 `exports`），否则 `npm pack` 会漏掉。

## 自动触发的作用域

挂在 `agent/pre-step`、`agent/turn-stopping`、`agent/status`、`session/event` 等**全局**事件上的插件，派发按线程数放大（N 个子代理多出 N 份调用）。

- **写入与派生默认只覆盖真人顶层会话**：落盘或调模型的自动行为先判断是否子代理会话；手动触发（RPC、插件页按钮）在各会话均可使用。
- **只读注入可保留**：记忆/经验注入只读数据，可直接注入。
- **跨子线程必须显式 opt-in** 并在注释写明理由。

判据只用 `session.header`（宿主建会话时的持久快照）；自建 `AbortController` 用 `AbortSignal.any([宿主 signal, 自己的])` 合并。

## 客户端 UI：@deepseek-ai/dsh-client-ui-primitives

宿主提供的纯 React 原子组件包（控件、图标、Markdown、JSON 检视器、设置表单套件、定位/浮层 hook）。浏览器端界面直接用它拼装，跟随宿主外观演进。本仓库当前插件 `dsh-mnemon-sync` 的页面沿用 dsh-mnemon 工作台的样式变量，不依赖此包。

## 本仓库现状

`plugins/dsh-mnemon-sync` 是零构建、零运行时依赖的纯 JS 插件：

- 包内相对路径（`./index.js` 等）即发布路径，不要引入 `src/` 构建产物。
- `package.json` 的 `files` 是打包白名单，新增文件必须同步列入，并跑 `pnpm pack:check`。
- `locale/en.json` / `zh.json` 的 `meta` 是市场上架文案，改动需同步 `site/catalog.json` 的 `summary` 与根 README 表格。
- 运行时契约字符串见根 `AGENTS.md`，`test/smoke.test.mjs` 会断言，禁止顺手改名。
