# plugins/ 专项规则

在 `plugins/**` 下开发插件时适用；通用规则见根目录 `AGENTS.md`。

## 官方包依赖约定

`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 由宿主运行时提供，声明在 `peerDependencies` 与 `devDependencies` 中，版本范围只写开放下界（写精确版本或 `<0.2.0` 上界会让 loader 命中 pnpm 装进 profile 的旧拷贝，导致版本检查失败并停用插件）。

- 宿主包含的包：`peerDependencies` 写开放下界 + `peerDependenciesMeta` 标 `optional: true`（避免 auto-install-peers 安装物理副本）；`devDependencies` 保留精确版本供 typecheck/测试。
- 宿主未内置的包：放入 `dependencies`，同样写开放下界。
- `engines.dsh` 同样只写开放下界。

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
