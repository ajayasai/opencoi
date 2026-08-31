# Third-party notices

OpenCOI is licensed under AGPL-3.0-only. Its compiled browser application also
redistributes the third-party components below under their own licenses. Those
licenses are not changed by the OpenCOI license.

## Browser-distributed components

| Component | Version | Distributed material | Declared license | Source |
| --- | ---: | --- | --- | --- |
| PDF.js (`pdfjs-dist`) | 6.2.108 | PDF parser, renderer, and worker | Apache-2.0 | <https://github.com/mozilla/pdf.js> |
| Tesseract.js | 6.0.1 | OCR coordinator and browser worker | Apache-2.0 | <https://github.com/naptha/tesseract.js> |
| Tesseract.js Core | 6.1.2 | WebAssembly OCR runtime | Apache-2.0 | <https://github.com/naptha/tesseract.js-core> |
| `@tesseract.js-data/eng` | 1.0.0 | English trained-data package | MIT in the npm package metadata; Apache-2.0 in the upstream data repository | <https://github.com/naptha/tessdata> |
| `is-url` | 1.2.4 | URL helper used by the OCR stack | MIT | <https://github.com/segmentio/is-url> |
| `tr46` | 0.0.3 | URL/Unicode helper used by the OCR stack | MIT | <https://github.com/Sebmaster/tr46.js> |
| `@napi-rs/canvas` platform packages | 1.0.8 | Optional PDF.js Node canvas runtime | MIT | <https://github.com/Brooooooklyn/canvas> |

The Apache-2.0 text supplied by the PDF/OCR projects is reproduced in
[`third_party_licenses/Apache-2.0.txt`](third_party_licenses/Apache-2.0.txt).
The published English data package does not contain a license file, so
[`third_party_licenses/tesseract-eng-package-MIT.txt`](third_party_licenses/tesseract-eng-package-MIT.txt)
reproduces the license declared by its npm metadata and identifies its listed
author and contributors. The upstream trained-data repository's Apache-2.0
license is included as well. The repository also preserves the exact `is-url`
and `@napi-rs/canvas` MIT texts and a curated MIT notice for the published
`tr46` package, whose package metadata declares MIT but whose tarball omits a
license file.

## Remaining runtime dependencies

The release workflow copies every `LICENSE`, `LICENCE`, `COPYING`, and `NOTICE`
file shipped by installed production dependencies into the application archive
under `third_party_licenses/runtime/`, preserving its package-relative path.
It also emits a machine-readable runtime license inventory and fails the
release if any installed production package lacks either a shipped license file
or an explicitly reviewed curated notice.
The container image retains those files inside `node_modules` and also includes
this notice and the curated license texts above. Exact dependency names,
versions, sources, and integrity hashes are recorded in `package-lock.json` and
in the CycloneDX SBOM attached to each GitHub release.

This file is provided for attribution and license compliance; it is not legal
advice. If a dependency's upstream licensing changes, update this inventory and
the accompanying license bundle before releasing the new version.
