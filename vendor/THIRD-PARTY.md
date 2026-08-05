# Third-party components bundled in `vendor/`

| File | Project | Licence |
|---|---|---|
| `pdf.min.mjs`, `pdf.worker.min.mjs` | [Mozilla pdf.js](https://github.com/mozilla/pdf.js) 4.6.82 | Apache License 2.0 |
| `pdf-lib.min.js` | [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 | MIT |
| `caveat.woff2` | [Caveat](https://fonts.google.com/specimen/Caveat) (latin subset) | SIL Open Font License 1.1 |
| `dancing.woff2` | [Dancing Script](https://fonts.google.com/specimen/Dancing+Script) (latin subset) | SIL Open Font License 1.1 |

All four are redistributable under the terms above. They are vendored rather than
loaded from a CDN so the app makes no third-party network requests and works offline.
