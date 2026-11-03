# dsh-rtk-workbench 参考手册（0.2.0）

适用：DSH `0.2.1-rc.5`、rtk `1.1.0`、Node `^22.19.0 || >=24`。安装后需要重启 `dsh web`（bundle 变更不是刷新页面）。

## 1. 安装与验证

```sh
dsh plugin --profile <profile> add dsh-rtk-workbench
```

装完重启，然后：

```
/rtk status     # 二进制、来源、pipeline 健康、开关、本会话省量
/rtk doctor     # 深度自检：版本、pipeline、一次真实往返、recall、trust
/rtk tools      # 每个可见工具如何被识别（规范名 / 别名 / 显式配置）
```

`binary` 行写明来源：`bundled`（随包二进制，推荐）、`path`（PATH 上的 rtk）、`config`/`env`（显式指定）。解析顺序：`rtkPath` → `RTK_BIN` / `DSH_RTK_BIN` → 内置平台包 → PATH 上的 `rtk`。

## 2. 命令参考

| 命令 | 作用 |
|---|---|
| `/rtk status` | 二进制与来源、探测结果、版本、recall 库状态、pipeline 模式与健康、改写/压缩/说明开关、已打补丁的工具、本会话省量与跳过原因 |
| `/rtk stats [--json]` | 本会话完整报告：压缩次数、输入/输出字节、耗时、按工具拆分、改写次数与回退、学习到的禁用动词、错误计数 |
| `/rtk tools` | 工具识别明细：`canonical`（官方名）、`alias`（如 `ops_bash`）、`explicit`（仅被显式列出） |
| `/rtk explain <命令>` | 为什么这条命令会/不会被改写：本地预过滤（方言、排除表、熔断）+ `rtk hook check` 的正式判定 |
| `/rtk doctor` | 逐项自检：二进制、`pipeline show/validate/status`、`methods`、`trust`、`hook claude` 往返、recall |
| `/rtk gain` | 转发 `rtk gain`：rtk 全库统计（不是本会话）；本会话请看 `status` 的 `session` 行 |
| `/rtk recall <hash>` | 在宿主进程里恢复 rtk 省略的原文；模型 shell 被沙箱隔离时用它 |
| `/rtk on\|off <rewrite\|compress>` | 本会话内临时开关；`/rtk off compress` 可用来排查另一个结果变换器 |
| `/rtk help [topic]` | 命令列表；`topic` 可取 `pipeline`、`sandbox`、`recovery`、`config` |

`/rtk status` 的 `session` 行示例：

```
session    : 12 compressions 48.2 KB → 9.1 KB (-81%, ~9.8k tok), 1.4 s, 3 rewrites
skipped    : size 9, scope 4
learned    : rewrite suppressed for ls
```

## 3. 配置

所有键都在 `cordis.patch.yml` 里可覆盖，加载期校验，非法值直接报错。

| 键 | 默认 | 说明 |
|---|---|---|
| `rtkPath` | `''` | 显式二进制路径；空 = `RTK_BIN`/`DSH_RTK_BIN`/内置/PATH |
| `rtkSource` | `auto` | `auto` 优先内置；`path` 只走 PATH |
| `timeoutMs` | `2000` | 稳态单次调用预算；超时 = 不改写/不压缩 |
| `coldStartTimeoutMs` | `8000` | 首次调用预算；平台扫描未签名二进制时 2.7–5.8 s 很常见 |
| `rewriteEnabled` | `true` | 改写总开关 |
| `rewriteFallback` | `retry` | rtk 自身失败时是否重放原命令（只认 rtk 的失败签名） |
| `rewriteSandboxGuard` | `auto` | Windows 受限沙箱下跳过改写（见 `help sandbox`）；`off` 强制 |
| `rewriteSemanticGuard` | `enforce` | 校验改写结果仍在执行原命令；`off` 直接信任 rtk 的输出（rtk 1.1.0 会把 `next build` 改成 `rtk next`） |
| `shellTools` | `['bash','pwsh']` | 用于识别的 shell 名 |
| `rewriteTools` | `['bash','ops_bash','pwsh']` | 允许改写的工具名；`discoverShellTools` 打开时额外识别 shell 风格名字 |
| `rewriteExcludeCommands` | `['cat','type','bat','less','more','head','tail']` | 永远不改写的命令词 |
| `compressEnabled` | `true` | 压缩总开关 |
| `compressTools` | `['*']` | 允许压缩的工具；`*` = 全部文本结果 |
| `excludeTools` | `[]` | 任何情况下都不碰的工具 |
| `compressThresholdBytes` | `2048` | 全局压缩阈值 |
| `maxPayloadBytes` | `2097152` | 超过就跳过（rtk 的 hook stdin 上限 64 MiB） |
| `compressFileTools` | `false` | 是否也压文件读取工具的结果（默认否：宿主已限长，rtk 的 cap 会截断你要的源码） |
| `compressThresholdByFamily` | 见下 | 按命令首词的阈值覆盖，如 `pytest: 512` |
| `spillOriginal` | `auto` | 把压缩前原文写到会话私有 spill 存储：`auto`（rtk 恢复不可用时）/`always`/`off` |
| `maxSpillBytes` | `1048576` | 超过此大小不落盘 |
| `awarenessEnabled` | `true` | 注入提示段（只在探测确认 rtk 可用后注入） |
| `denyEnabled` | `false` | 遵守 rtk 的 deny 判定；DSH 无宿主权限规则，默认关 |
| `pipelineMode` | `auto` | `auto` 尊重已有用户 pipeline；`plugin-owned` 总是注入；`user` 不注入 |
| `annotateRewrites` | `true` | 是否加 `[rtk] ran:` 行 |
| `annotateStyle` | `short` | `short` 写裸 `rtk <cmd>`；`full` 带绝对二进制路径 |
| `annotateMinBytes` | `500` | 结果短于此值不加注解 |
| `rewriteCacheTtlMs` | `600000` | 同 `cwd + 命令` 的改写答案复用时长；0 关闭缓存 |
| `discoverShellTools` | `true` | 把 shell 风格的新工具名也当作 shell |

`compressThresholdByFamily` 默认：`pytest`、`cargo`、`docker`、`git`、`npm`、`pnpm`、`yarn`、`make`、`go`、`mvn`、`gradle` 均为 512 B；未列出的用 `compressThresholdBytes`。

`RTK_DB_PATH` 与 `RTK_TEE_DIR` **刻意不覆盖**：`rtk recall` 是模型在普通 shell 里跑的，重定向 tee/DB 会让恢复彻底失效。

## 4. 模型侧会看到什么

- `[rtk] ran: rtk git status`：这条命令被改写成 rtk 形式执行（`annotateStyle: full` 时带二进制路径）。
- `[rtk] fell back: git status`：rtk 自己没能跑起来，插件重放了原命令；该命令词本会话内不再改写。
- `[rtk] <提示>`：rtk 自带的提醒，例如 Read 输出被格式转换（toon/摘要）时警告不要用转换后的文本拼 `Edit` 的 `old_string`。
- `[rtk] original saved: <path> — …`：压缩前的原文落到了会话私有 spill 文件，可直接 `read`/`grep`。
- 结果末尾的 `rtk recall <hash>`：rtk 自己的恢复指针。
- 系统提示里的一段静态说明（只在探测通过后注入）。

## 5. 恢复原文

1. 结果里有 `[rtk] original saved: <path>` → 直接读该路径（沙箱内也可以）。
2. 结果里有 `rtk recall <hash>` → 普通 shell 可读 rtk 库时执行 `rtk recall <hash>`；否则让用户运行 `/rtk recall <hash>`（宿主进程不受沙箱限制）。
3. 两者都没有且结果明显残缺 → `/rtk doctor` 看 recall 与 pipeline 状态。

## 6. 兼容性

| 组件 | 版本 |
|---|---|
| DeepSeek Harness | `0.2.1-rc.5`（目标；`package.json` 的 `dshTarget`） |
| rtk | `1.1.0`（内置；`dshRtkVersion`） |
| Node | `^22.19.0 || >=24` |
| 插件 | `0.2.0` |

下表描述插件的**可观察行为**；`skipped` 一律指"在 spawn 之前就拒绝"，不是"试了但静默失败"。

| 环境 | 改写 | 压缩 | 恢复 | 说明 |
|---|---|---|---|---|
| Linux x64/arm64 原生 | 完整 | 完整 | 完整 | 首选：bash 原生、rtk 原生、库可写 |
| macOS x64/arm64 原生 | 完整 | 完整 | 完整 | 同 Linux；CI 待跑 |
| Windows + `danger-full-access` | 完整 | 完整 | 完整 | 维护者机器实测；`ls`/`grep` 改写可用 |
| Windows + `workspace-write` | **跳过** | 完整 | spill | 宿主拒绝 rtk 派生子进程（`os error 5`）；`rewriteSandboxGuard: off` 强制并会失败 |
| Windows + `read-only` | **跳过** | 完整 | spill | 同样的拒绝；且没有可写目录 |
| Windows + WSL 作为 shell 后端 | 未支持 | 部分 | spill | Windows 的 `rtk.exe` 在发行版里不可见；建议 `rewriteTools: []` |
| DSH 跑在 WSL（Linux 宿主） | 完整 | 完整 | 完整 | 按 Linux 处理 |

`spill` 指 rtk 自己的 recall 不可达时，原文经宿主 spill 存储落盘并在结果里给出路径。

**共存。** 以别名重新发布的 shell 工具（如 `ops_` 前缀）通过别名表与 `discoverShellTools` 识别；改写调用工具自己的 `execute`，所以其宿主的沙箱语义仍然生效。压缩监听器永远先 `await next()`，再变换下游决策携带的内容；别的变换器改过内容时，`/rtk status` 会显示 `observed: another result transformer changed N result(s)`，不点名插件。若别的插件持续替换我们的 `execute` 包装，插件在三次之后停止重包并在 `skipped` 里说明。已被宿主 spill 策略替换的结果带标记，不会被再次压缩。`RTK_CONFIG_DIR` 只给插件自己的 spawn 设置（且只在 `plugin-owned`/`auto` 下），用户的 `config.toml` 与 `filters.toml` 从不被覆盖。

**共存矩阵。** "不可"表示两者抢同一个宿主缝，同一时刻只能有一个生效。

| 同装插件 | 结果 | 处理 |
|---|---|---|
| 执行器替换类（`dsh-rtk`、`dsh-bash-rtk`、`dsh-pwsh-rtk-rewrite`） | **不可同装**：都替换 `ctx.shell`，宿主每个 context 只允许一个实现 | 只选一个，其余禁用 |
| `dsh-rtk-bridge`（也包装 `execute`） | 两者争同一个包装；其中一方在三次重包后停止并在 `skipped` 里说明 | 只留一个改写器；看 `/rtk status` |
| `dsh-router-ext-rtk`（短路 `tools/execute`） | 它先改写；本插件看到 `rtk` 前缀就跳过改写，压缩照常 | 安全，只会改写一次 |
| `dsh-token-saver`（在 `tools/post-execute` 裁剪） | 安全：它的裁剪标记会被识别，本层不再动那段文本 | 不会二次裁剪 |
| `billion-context`（折叠旧对话、ACP 标记） | 安全：带 ACP 标记的内容直接跳过 | 无需处理 |

**语义守卫。** 执行改写结果前，插件逐段确认它仍在执行原命令：普通前缀（`git status` → `rtk git status`）、`gradle` → `gradlew` 映射、或路径与行数都保留的 `read` 映射。任何丢了参数的提案——rtk 1.1.0 会把 `next build` 变成 `rtk next`、把 `python -m pytest` 变成 `rtk pytest`——会被拒绝，原命令照跑，并在 `/rtk stats` 的 `guard` 计数里体现。`/rtk explain <命令>` 会给出单条命令的判定。被拒的改写仍会照常走 post-execute 压缩。

**版本策略。** 平台子包与主包同版本并记录内置 rtk 版本；DSH 升级后按新 tag 重跑兼容检查再发版。rtk 的参考源码用与内置二进制一致的发布 tag（`release-v1.1.0`），不用 `develop`。

## 7. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `rtk is not usable` | 二进制缺失/超时 | 看 `status` 的 `probe` 行；冷启动多等一次；或设 `rtkPath` |
| 压缩从不生效 | 结果低于阈值、被 `scope` 跳过、pipeline 回退 | `/rtk stats` 看 `skipped`；`/rtk doctor` 看 `validate`/`pl status` |
| `compress : on` 但省量为 0 | injected pipeline 失效（回退 `rtk:default`） | `status` 的 `pipeline` 行与 `compress` 告警；`/rtk doctor` |
| 命令莫名失败 | rtk 派生子进程被拒（沙箱） | `rewriteSandboxGuard` 默认已抑制；若强制打开则关掉 |
| `rtk recall` 报 store 错误 | shell 被沙箱隔离 | 让用户 `/rtk recall`，或读 spill 路径 |
| 一个动词反复失败 | 运行环境跑不了该动词 | 已被熔断；`status` 的 `learned` 行确认 |
| 改写后像是另一条命令 | rtk 的提案丢了参数（`next build` → `rtk next`） | 语义守卫会跑原命令；看 `/rtk stats` 的 `guard` 与 `/rtk explain <命令>` |
| 结果被别的插件改过 | 另一个结果变换器在跑 | `status` 的 `observed` 行；`/rtk off compress` 对比 |

## 8. 已知限制（宿主差异，不是实现缺陷）

- DSH 没有 PreToolUse 命令改写钩子，插件只能包装工具执行；无法让宿主本身改写命令。
- DSH 没有 `RTK.md` 注入机制，改用静态提示段。
- `rtk session` / `discover` / `learn` 读 Claude Code 的历史数据，对 DSH 无意义。
- rtk 的 deny 规则读 `~/.claude` 权限配置，DSH 没有这套语义，因此默认关闭。
- Windows 受限沙箱下 rtk 无法派生真实命令，改写物理不可用（压缩不受影响）。
- `fish` 脚本包装、`rtk init` 认领 DSH、Windows 上的 WSL 后端均无对应支持。

## 9. 设计说明

- 包装 `ToolDefinition.execute` 而不重派发，保留注册表的信号融合与记账。
- 把 rtk 当纯函数用（`rtk rewrite` 字符串进出、`rtk hook claude` JSON 进出）；DSH 没有可装的 hook。
- pipeline 通过 `RTK_CONFIG_DIR` 自管；`auto` 在用户 pipeline 已能压缩时撤掉覆盖。
- 改写失败重放原命令并拉黑该动词，坏环境退化成"普通命令"而不是"坏命令"。
- 压缩范围按调用形状决定（文件/搜索不动）；rtk recall 不可达时把原文落盘。
- 会话计数只在内存：回答"本插件本会话做了什么"，不替代 rtk 的全局库。
- Windows 受限沙箱直接跳过改写（rtk 无法派生子进程），压缩不受影响。
- 改写结果先过语义守卫：只接受前缀、`gradle→gradlew` 与参数保留的 `read` 映射，其余退回原命令。
