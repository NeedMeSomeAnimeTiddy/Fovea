# Third-party notices

Fovea bundles the official unmodified Windows executable from the OpenAI
Codex release `rust-v0.144.4` (`openai/codex`). Codex is licensed under the
Apache License 2.0; the complete licence is included as `CODEX-LICENSE.txt`.

Source and release materials:

- https://github.com/openai/codex/tree/rust-v0.144.4
- https://github.com/openai/codex/releases/tag/rust-v0.144.4

The Codex executable incorporates open-source Rust dependencies. Their
copyright and licence metadata remain available in the tagged upstream source
and Cargo manifests. No upstream `NOTICE` file is published at the repository
root for this pinned release.

Electron, React, Vite, and the other JavaScript packages used to build
Fovea retain their respective licences in `node_modules` during development
and in Electron Builder's packaged application metadata where included.

Fovea also bundles Tesseract.js 7.0.0 and tesseract.js-core 7.0.0 for local
optical character recognition. Both packages are licensed under the Apache
License 2.0; the complete licence text is included as `CODEX-LICENSE.txt`.

Fovea bundles `@zxing/library` 0.21.3 from
https://github.com/zxing-js/library for local QR-code and barcode detection.
Its distributed licence file contains the Apache License 2.0 and the
third-party jai-imageio attribution notice; the complete Apache licence text is
included as `CODEX-LICENSE.txt`.

The bundled English trained-data package is
`@tesseract.js-data/eng` 1.0.0, published from
https://github.com/naptha/tessdata and declared under the MIT License:

Copyright (c) Balearica and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
