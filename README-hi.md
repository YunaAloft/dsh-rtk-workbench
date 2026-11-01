<p align="center">
  <img src="https://raw.githubusercontent.com/YunaAloft/dsh-rtk-workbench/main/docs/readme/header.svg" alt="dsh-rtk-workbench" width="900">
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README-zh.md">中文</a> · <strong>हिन्दी</strong>
</p>

<p align="center">
  <em>DeepSeek Harness में [rtk (Rust Token Killer)](https://github.com/rtk-ai/rtk) जोड़ता है — और बाइनरी साथ लाता है।</em><br>
  <sub>जो बदल सकते हैं बदलें · जो बचे उसे संक्षिप्त करें · मॉडल को बताएं क्या हुआ</sub>
</p>

## Why this exists

rtk कमांड बदलता है और मॉडल के पढ़ने से पहले टूल आउटपुट संक्षिप्त करता है। यह 20 एजेंटों को सपोर्ट करता है; **DeepSeek Harness उनमें नहीं है**। मौजूदा प्लगइन केवल कमांड रीराइट लागू करते हैं — आउटपुट कम्प्रेशन, संदर्भ अनुभाग और साथ आने वाली बाइनरी यह प्लगइन जोड़ता है।

## What you get

- **रीराइट** — `ToolDefinition.execute` को लपेटता है; परिणाम `[rtk] ran: …` से शुरू होता है
- **कम्प्रेशन** — 2048 B से बड़े परिणामों पर `tools/post-execute` में `rtk hook claude`
- **संदर्भ** — सिस्टम प्रॉम्प्ट का एक स्थिर अनुभाग
- **rtk शामिल** — प्रति-प्लेटफ़ॉर्म बाइनरी, वैकल्पिक निर्भरता के रूप में
- **`/rtk` कमांड** — `status`, `tools`, `doctor`, `gain`, `recall`, `on|off`

## Install

```sh
dsh plugin --profile web add dsh-rtk-workbench
```

इंस्टॉल के बाद होस्ट रीस्टार्ट करें (bundle बदलाव पेज रीलोड नहीं है)। **rtk अलग से इंस्टॉल करने की ज़रूरत नहीं**: आपके प्लेटफ़ॉर्म की बाइनरी वैकल्पिक निर्भरता है। क्रम: `rtkPath` → `RTK_BIN`/`DSH_RTK_BIN` → बंडल पैकेज → `PATH`।

## Quick start

सत्र में `/rtk status`, `/rtk doctor`, `/rtk tools` चलाएँ। फिर `git status` चलवाएँ (`[rtk] ran: rtk git status` दिखेगा) या बड़ी लॉग फ़ाइल पर `cat` (`[full output: rtk recall <hash>]` दिखेगा)।

## How it works

- Rewriting wraps the registered tool `execute`; it never replaces `ctx.shell`.
- Compression runs in `tools/post-execute`, always after `await next()`, and replaces only the content.
- Every failure path is fail-open: missing binary, timeout, unreadable answer → the call runs untouched.

## Measured effect

रीराइट: `git status` 377 B → 47 B (−87.5 %), 20 कमिट का `git log` 3 578 B → 1 698 B (−52.5 %), 300 मिलान वाला `grep` 20 364 B → 2 190 B (−89.2 %). कम्प्रेशन: pytest आउटपुट 89 505 B → 11 287 B (−87.4 %), 5 000 पंक्तियों का लॉग 272 640 B → 13 633 B (−95.0 %), lockfile 76 896 B → 4 654 B (−93.9 %). `node scripts/benchmark.mjs` से दोबारा मापा जा सकता है; पूरे README में token स्तंभ bytes/4 अनुमान है।

## Coexistence

`ctx.shell` नहीं लेता, `tools/post-execute` में हमेशा `await next()` करता है, और किसी दूसरे प्लगइन का नाम नहीं लेता या उसे रोकता नहीं: यदि किसी और listener ने परिणाम बदला है तो वह पहचानकर `/rtk status` में बताता है।

## Configuration


## Troubleshooting

यदि `/rtk status` कहे `rtk is not usable`, वह पंक्ति कारण बताती है (`spawn`, `timeout`, `exit`)। यदि `via path` लिखा हो तो आपके प्लेटफ़ॉर्म का पैकेज इंस्टॉल नहीं हुआ: `rtkPath` सेट करें या rtk स्वयं इंस्टॉल करें।

## Development

`pnpm install` → `tsc --noEmit` → `vitest run` → `tsdown` → `scripts/build-vendor.mjs` → `scripts/release.mjs --dry-run`.

## Credits

कम्प्रेशन नियम और `hook` प्रोटोकॉल [rtk](https://github.com/rtk-ai/rtk) का काम है (Apache-2.0); यह प्लगइन DeepSeek Harness के लिए अनुकूलक है और rtk 1.1.0 को अपरिवर्तित वितरित करता है।

## License

[Apache License 2.0](./LICENSE) © 2026 dsh-rtk-workbench contributors.
