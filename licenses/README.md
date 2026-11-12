# Licenses in this package

This plugin's own code (everything under `src/`, `lib/`, `locale/`, `cordis.patch.yml`) is
**Apache-2.0** — see [`../LICENSE`](../LICENSE).

The bundled `rtk` binary is a third-party component with two licenses, both reproduced here
because the binary cannot be distributed without them:

| File | Covers | License |
|---|---|---|
| [`rtk-LICENSE`](./rtk-LICENSE) | the `rtk` command-line tool | Apache-2.0 |
| [`rtk-LICENSE-ENGINE`](./rtk-LICENSE-ENGINE) | `rtk-engine`, which the `rtk` binary links for its compression pipeline | Business Source License 1.1 |

## What the BUSL means for you

`rtk-engine` is source-available rather than open source. Its Additional Use Grant says, in
substance:

- **production use is free**, including as a component of the `rtk` binary — so running this
  plugin, at home or inside a company, needs no license or payment;
- what the grant does **not** cover is offering rtk-engine (or a derivative) to third parties as
  a **paid or hosted product or service** — for that, contact `contact@rtk-ai.app`;
- on **2030-09-09** (the Change Date) the engine's license becomes Apache-2.0.

This plugin only bundles the unmodified upstream binary, publishes its full license texts, and
adds no restriction of its own on top of them.

## Upstream

- Source: <https://github.com/rtk-ai/rtk>
- Which version is bundled: `dshRtkVersion` in `package.json` (currently `1.2.0`), also printed by
  `/rtk status` and recorded in `dist/github/manifest.json` of each release.
