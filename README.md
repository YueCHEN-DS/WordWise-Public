# WordWise

WordWise is a desktop English vocabulary learning app for focused practice and
long-term retention. It helps learners build a personal word list, practise at
their own pace, review mistakes, and see which words are easiest to confuse.

The app is designed to work locally. Learning records stay on the device, and
optional local language-model support can provide semantic feedback for typed
answers.

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

## Downloads
### We are now provide the online trail version which is accessible in [WordWise-Web](https://wordwise.dpdns.org) [recently not available in China Mainland]

- Baidu Netdisk: [WordWise-v1.0.0](https://pan.baidu.com/s/1LD4QVatnQr7FSxPloC1c5A) code: vjra 
- Google Drive: [WordWise-v1.0.0](https://drive.google.com/drive/folders/1jb0jFgo42EUx7rVZQSWyhnYVrrr3LOGF?usp=sharing)

**contact to the developer at feedback@wordwise.dpdns.org for one year free trial**

## License

WordWise is released under the MIT License. See [`LICENSE`](LICENSE).
