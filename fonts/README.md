# fonts

console 用到的字体，本地打包，离线可用，不连 Google Fonts。

| 文件 | 字体 | 说明 |
| --- | --- | --- |
| `cormorant-garamond-500.woff2` / `-italic` | Cormorant Garamond Medium | 拉丁字符子集，英文点缀与数字 |
| `noto-serif-sc-400.woff2` / `-600` | Noto Serif SC | GB2312 全部汉字 + 常用标点子集；子集外的字回落到系统宋体 |

Mac / iOS 优先用系统自带的宋体（Songti SC），只有没有时才下载这里的 Noto Serif SC。
"Yours" 书写体（Pinyon Script）已转成 SVG 路径内联在 `console.html`，不需要字体文件。

许可：SIL Open Font License 1.1，见 [OFL.txt](OFL.txt)。
