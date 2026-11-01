<p align="center">
  <img src="https://raw.githubusercontent.com/YunaAloft/dsh-rtk-workbench/main/docs/readme/header.svg" alt="dsh-rtk-workbench" width="900">
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README-zh.md">中文</a> · <strong>Português</strong>
</p>

<p align="center">
  <em>Leva o [rtk (Rust Token Killer)](https://github.com/rtk-ai/rtk) ao DeepSeek Harness — e traz o binário junto.</em><br>
  <sub>reescreva o que dá · comprima o que sobra · conte ao modelo o que aconteceu</sub>
</p>

## Why this exists

O rtk reescreve comandos e comprime a saída das ferramentas antes de o modelo lê-la. Ele suporta 20 agentes; **o DeepSeek Harness não é um deles**. Os plugins existentes implementam apenas a reescrita — compressão de saída, seção de contexto e binário incluído são o que este plugin acrescenta.

## What you get

- **Reescrita** — envolve `ToolDefinition.execute`; o resultado começa com `[rtk] ran: …`
- **Compressão** — `rtk hook claude` em `tools/post-execute` para resultados ≥ 2048 B
- **Contexto** — uma seção estática do prompt de sistema
- **rtk incluído** — binário por plataforma como dependência opcional
- **Comandos `/rtk`** — `status`, `tools`, `doctor`, `gain`, `recall`, `on|off`

## Install

```sh
dsh plugin --profile web add dsh-rtk-workbench
```

Reinicie o host depois de instalar (mudança de bundle não é recarregar a página). **Não é preciso instalar o rtk separadamente**: o binário da sua plataforma é uma dependência opcional. Ordem: `rtkPath` → `RTK_BIN`/`DSH_RTK_BIN` → pacote incluído → `PATH`.

## Quick start

Rode `/rtk status`, `/rtk doctor` e `/rtk tools` dentro de uma sessão. Depois peça `git status` (verá `[rtk] ran: rtk git status`) ou `cat` de um log grande (verá `[full output: rtk recall <hash>]`).

## How it works

- Rewriting wraps the registered tool `execute`; it never replaces `ctx.shell`.
- Compression runs in `tools/post-execute`, always after `await next()`, and replaces only the content.
- Every failure path is fail-open: missing binary, timeout, unreadable answer → the call runs untouched.

## Measured effect

Reescrita: `git status` 377 B → 47 B (−87,5 %), `git log` de 20 commits 3 578 B → 1 698 B (−52,5 %), `grep` com 300 ocorrências 20 364 B → 2 190 B (−89,2 %). Compressão: saída do pytest 89 505 B → 11 287 B (−87,4 %), log de 5 000 linhas 272 640 B → 13 633 B (−95,0 %), lockfile 76 896 B → 4 654 B (−93,9 %). Reproduzível com `node scripts/benchmark.mjs`; a coluna de tokens do README completo é uma estimativa bytes/4.

## Coexistence

Não ocupa `ctx.shell`, sempre faz `await next()` em `tools/post-execute` e nunca nomeia nem bloqueia outros plugins: se outro listener já transformou um resultado, ele detecta e informa em `/rtk status`.

## Configuration

A tabela completa de configuração está no [README em inglês](./README.md#configuration). `deny` e o portão de leitura vêm desligados.

## Troubleshooting

Se `/rtk status` disser `rtk is not usable`, a linha indica o motivo (`spawn`, `timeout`, `exit`). Se disser `via path`, o pacote da sua plataforma não foi instalado: defina `rtkPath` ou instale o rtk você mesmo.

## Development

`pnpm install` → `tsc --noEmit` → `vitest run` → `tsdown` → `scripts/build-vendor.mjs` → `scripts/release.mjs --dry-run`.

## Credits

As regras de compressão e o protocolo `hook` são trabalho do [rtk](https://github.com/rtk-ai/rtk) (Apache-2.0); este plugin é o adaptador para o DeepSeek Harness e distribui o rtk 1.1.0 sem modificações.

## License

[Apache License 2.0](./LICENSE) © 2026 dsh-rtk-workbench contributors.
