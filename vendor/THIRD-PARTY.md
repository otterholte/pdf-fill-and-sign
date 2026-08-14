# Third-party components bundled in `vendor/`

| File | Project | Licence |
|---|---|---|
| `pdf.min.mjs`, `pdf.worker.min.mjs` | [Mozilla pdf.js](https://github.com/mozilla/pdf.js) 4.6.82 | Apache License 2.0 |
| `pdf-lib.min.js` | [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 | MIT |
| `peerjs.min.js` | [PeerJS](https://github.com/peers/peerjs) 1.5.5 | MIT |
| `qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 | MIT |
| `caveat.woff2` | [Caveat](https://fonts.google.com/specimen/Caveat) (latin subset) | SIL Open Font License 1.1 |
| `dancing.woff2` | [Dancing Script](https://fonts.google.com/specimen/Dancing+Script) (latin subset) | SIL Open Font License 1.1 |

All are redistributable under the terms above. They are vendored rather than
loaded from a CDN so the app makes no third-party network requests for its own
code and works offline. The one third-party service the app can contact is the
PeerJS signalling broker, used only while "use your phone as the camera" is
open, and only to introduce the two browsers to each other — the photo itself
travels directly between the devices and never passes through it.
