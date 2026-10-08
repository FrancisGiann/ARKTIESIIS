# Synthetic document precheck fixtures

These six small, valid PDF files are deterministic, fictional fixtures for local evaluation and tests. They contain invented names and school wording only. Their expected labels are in `manifest.json`.

Run the local validation without provider requests:

```bash
npm run evaluate:document-precheck
```

Run a live evaluation only when explicitly intended:

```bash
npm run evaluate:document-precheck -- --live
```

The live command sends only these listed sample bytes to Gemini. Its output contains aggregate counts and latency, never sample names, fields, paths, provider errors, or credentials. Synthetic fixture results are not representative school accuracy.
