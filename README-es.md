<p align="center">
  <img src="https://raw.githubusercontent.com/YunaAloft/dsh-rtk-workbench/main/docs/readme/header.svg" alt="dsh-rtk-workbench" width="900">
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README-zh.md">中文</a> · <strong>Español</strong>
</p>

<p align="center">
  <em>Lleva [rtk (Rust Token Killer)](https://github.com/rtk-ai/rtk) a DeepSeek Harness — y trae el binario incluido.</em><br>
  <sub>reescribe lo que puede · comprime lo que queda · le explica al modelo qué pasó</sub>
</p>

## Why this exists

rtk reescribe comandos y comprime la salida de las herramientas antes de que el modelo la lea. Trae sus propios adaptadores para 20 agentes —para Claude Code instala un hook `PreToolUse` en su configuración, y los otros 19 funcionan igual—. **DeepSeek Harness no tenía ninguno de esos adaptadores: este plugin es el que faltaba**. Los plugins existentes solo implementan la reescritura: la compresión de salida, la sección de contexto y el binario incluido son lo que este plugin añade.

## What you get

- **Reescritura** — envuelve `ToolDefinition.execute`; el resultado empieza con `[rtk] ran: …`
- **Compresión** — `rtk hook claude` en `tools/post-execute` para resultados ≥ 2048 B
- **Contexto** — una sección estática del prompt de sistema
- **rtk incluido** — binario por plataforma como dependencia opcional
- **Comandos `/rtk`** — `status`, `tools`, `doctor`, `gain`, `recall`, `on|off`

## Install

```sh
dsh plugin --profile web add dsh-rtk-workbench
```

Reinicia el host después de instalar (un cambio de bundle no es recargar la página). **No hace falta instalar rtk por separado**: el binario de tu plataforma es una dependencia opcional. Orden de resolución: `rtkPath` → `RTK_BIN`/`DSH_RTK_BIN` → paquete incluido → `PATH`.

## Quick start

Ejecuta `/rtk status`, `/rtk doctor` y `/rtk tools` dentro de una sesión. Luego pide `git status` (verás `[rtk] ran: rtk git status`) o `cat` de un registro grande (verás `[full output: rtk recall <hash>]`).

## How it works

- Rewriting wraps the registered tool `execute`; it never replaces `ctx.shell`.
- Compression runs in `tools/post-execute`, always after `await next()`, and replaces only the content.
- Every failure path is fail-open: missing binary, timeout, unreadable answer → the call runs untouched.

## Measured effect

Reescritura: `git status` 377 B → 47 B (−87,5 %), `git log` de 20 commits 3 578 B → 1 698 B (−52,5 %), `grep` con 300 coincidencias 20 364 B → 2 190 B (−89,2 %). Compresión: salida de pytest 89 505 B → 11 287 B (−87,4 %), registro de 5 000 líneas 272 640 B → 13 633 B (−95,0 %), lockfile 76 896 B → 4 654 B (−93,9 %). Reproducible con `node scripts/benchmark.mjs`; la columna de tokens del README completo es una estimación bytes/4.

## Coexistence

No ocupa `ctx.shell`, siempre hace `await next()` en `tools/post-execute`, y nunca nombra ni bloquea otros plugins: si otro listener ya transformó un resultado, lo detecta y lo informa en `/rtk status`.

## Configuration

La tabla completa de configuración está en el [README en inglés](./README.md#configuration). `deny` y la puerta de lectura vienen desactivados.

## Troubleshooting

Si `/rtk status` dice `rtk is not usable`, la línea indica el motivo (`spawn`, `timeout`, `exit`). Si dice `via path`, el paquete de tu plataforma no se instaló: define `rtkPath` o instala rtk tú mismo.

## Development

`pnpm install` → `tsc --noEmit` → `vitest run` → `tsdown` → `scripts/build-vendor.mjs` → `scripts/release.mjs --dry-run`.

## Credits

Las reglas de compresión y el protocolo `hook` son trabajo de [rtk](https://github.com/rtk-ai/rtk); este plugin es el adaptador para DeepSeek Harness y distribuye el binario de rtk sin modificar. Ese binario es Apache-2.0 y enlaza `rtk-engine` bajo BUSL-1.1 (source-available; el uso en producción es gratuito y la licencia pasa a Apache-2.0 el 2030-09-09, pero no permite ofrecer rtk como producto o servicio de pago). Ambos textos se incluyen en [`licenses/`](./licenses).

## License

[Apache License 2.0](./LICENSE) © 2026 dsh-rtk-workbench contributors.
