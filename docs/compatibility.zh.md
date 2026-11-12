# 兼容性台账

本插件实际验证过哪些宿主版本，以及每一行的证据。每次发版前新增或刷新一行（行为矩阵见 `docs/reference.zh.md` § 6，安装见 `README-zh.md`）。

## 已验证宿主

| 宿主（`@deepseek-ai/dsh`） | rtk | 验证日期 | 证据 | 说明 |
|---|---|---|---|---|
| `0.2.2-rc.1` | `1.2.0` | 2026-11-13 | `pnpm typecheck`（host + client 两个编译面）；`pnpm test`（18 文件、225 用例）；`pnpm build`；`check-manifest`；`check-docs`；`verify-host`；web profile 用本地 1.1.1-test.0 包验收（`web route` authenticated、401/403、药丸与会话切换） | 1.1.1 |
| `0.2.2-rc.1` | `1.2.0` | 2026-11-12 | `pnpm typecheck`（host + client 两个编译面）；`pnpm test`（18 文件、220 用例）；`check-manifest`；`check-docs`；`build-vendor` 走 1.2.0 发布（5 平台、checksums 校验通过）；Windows vendor 二进制冒烟（`rtk 1.2.0 --version`）；确定性基准重跑（484 408 B → 40 590 B） | 1.1.0（2026-11-12 发布） |
| `0.2.2-rc.1` | `1.1.0` | 2026-11-05 | `pnpm typecheck`（host + client 两个编译面）；`pnpm test`（17 文件、200 用例）；`check-manifest`；`check-docs`；打包产物的 `smoke-pack`；维护者桌面冒烟（药丸 + 浮层、改写、压缩、`recall`） | 1.0.0 目标版本 |
| `0.2.1-rc.5` | `1.1.0` | 2026-11-03 | `pnpm typecheck`；`pnpm test`（12 个文件、145 个用例）；`check-manifest`；`check-docs`；维护者 Windows 11 冒烟（`/rtk status`、改写、压缩、recall） | 0.2.0 目标版本，历史记录 |
| `0.2.1-rc.3` / `rc.4` | `1.1.0` | 2026-11-01 | M0 headless 实测：rtk 退出码 0/1/2/3、`hook claude` 往返、沙箱行为 | 0.1.x 线，历史记录 |

## `package.json` 声明的范围

| 字段 | 范围 | 含义 |
|---|---|---|
| `engines.dsh` | `>=0.2.0-0 <0.3.0` | 可加载的宿主线 |
| `@deepseek-ai/dsh-tools`（peer） | `>=0.1.2-rc.1 <0.3.0`（prerelease 分支写法） | 工具运行时契约（`ToolDefinition.execute`、pre/post-execute） |
| `@deepseek-ai/cordis`（peer） | `^4.0.2` | 插件/上下文运行时 |

## 怎么检查一个宿主

```sh
node scripts/verify-host.mjs                 # 探测本机安装的宿主
node scripts/verify-host.mjs --host-version 0.2.2-rc.1
node scripts/verify-host.mjs --self-test      # 自测范围匹配器
```

脚本读取 `package.json`，把 `engines.dsh` 与所有 `@deepseek-ai/dsh*` peer 范围逐个对目标版本校验，打印一行台账，不匹配时以非零码退出。

## "已验证"指什么

- **单元/契约**：该提交上的仓库门禁（`typecheck`、`vitest`、`check-manifest`、`check-docs`）全绿。
- **运行时冒烟**：维护者把打好的 tarball 装进干净 profile，重启宿主，依次跑 `/rtk status`、`/rtk doctor`、一条被改写的命令与一条被压缩的结果。
- **不声称**：所有平台 × 沙箱模式 × 同装插件的组合都验证过；边界写在 `docs/reference.zh.md` § 6 的行为矩阵里。
