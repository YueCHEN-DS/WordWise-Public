# WordWise

WordWise is a desktop English vocabulary learning app for focused practice and
long-term retention. It helps learners build a personal word list, practise at
their own pace, review mistakes, and see which words are easiest to confuse.

**We are now releasing some parts of its core algorithms**

The app is designed to work locally. Learning records stay on the device, and
optional local language-model support can provide semantic feedback for typed
answers.

<!-- wordwise-web-v2:begin -->
## WordWise Web v2.0 — Public Beta

**[Open WordWise Web](https://wordwise.dpdns.org/)** to register or sign in with
your existing account. The hosted portal is now v2.0; the desktop downloads
below remain v1.0. This repository continues to provide selected desktop source
and core algorithms, rather than the hosted service's complete source code.

- Practise English vocabulary with Chinese or French answers.
- Choose a French, Chinese or English interface. The first visit follows your
  browser language: French → French, Chinese → Chinese, otherwise English.
  Your saved choice takes priority on later visits.
- Change the interface language under **Settings & vocabulary → Language**.
  A compact language selector is also available before login. The language
  choice sets a default study mode; the sidebar lets you choose the study mode
  separately.
- French study offers **TOEFL, IELTS, Tous les mots** and your personal list
  (**Mes mots**), with adaptive practice, mistake review, a confusion map,
  hints and vocabulary import/export.

<!-- wordwise-web-v2:end -->

## Highlights

- Random, sequential, and adaptive practice modes
- Spaced review and mistake-focused practice
- Personal confusion map for recurring mix-ups
- Import and export for personal vocabulary lists
- macOS and Windows desktop packaging support

## Quick start

```bash
npm install
npm test
npm start
```

The native vocabulary engine can be rebuilt locally with Rust when a matching
prebuilt module is not available:

```bash
npm run build --prefix vocab-core
```

The public source snapshot intentionally does not include local model weights,
bundled wordlists, audio archives, paid distribution assets, private research
material, operator-only license tooling, or release packages. When adding
vocabulary or model files, use sources you are permitted to redistribute.

<!-- wordwise-public-tools:begin -->
## Public developer tools

The source includes audio packing, vocabulary database preparation and desktop
packaging helpers. Two additional read-only checks inspect the **staged public
file allowlist** and **macOS/Windows package file selection**:

```bash
npm run check:public-files
npm run check:package-files
```

<!-- wordwise-public-tools:end -->

## Downloads
### We are now provide the online trail version which is accessible in [WordWise-Web](https://wordwise.dpdns.org)
- Baidu Netdisk: [WordWise-v1.0.0](https://pan.baidu.com/s/1LD4QVatnQr7FSxPloC1c5A) code: vjra 
- Google Drive: [WordWise-v1.0.0](https://drive.google.com/drive/folders/1jb0jFgo42EUx7rVZQSWyhnYVrrr3LOGF?usp=sharing)

**If you have any questions, contact to the developer at feedback@wordwise.dpdns.org for one year free trial**

## License

WordWise is released under the MIT License. See [`LICENSE`](LICENSE).
