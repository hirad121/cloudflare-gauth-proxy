# Contributing

Small, focused repo — the bar for contributing is low.

## Before opening a PR

```bash
npm install
npm run typecheck
npm test
```

CI runs both on every push/PR. If your change adds a new code path, add a
test for it in `test/index.test.ts` rather than only checking manually
against `npm run dev`.

## Style

- Match what's already in `src/index.ts`: comments explain *why*, not
  *what* — the code says what it does.
- No new dependencies for anything the Workers runtime already provides
  (`fetch`, `caches`, `AbortController` are global).
- Keep `src/index.ts` as the single source file unless a change genuinely
  needs a second module — this repo is deliberately small enough to read in
  one sitting.

## Reporting bugs

Open an issue with the request path, expected vs. actual response, and
whether it reproduces against `npm run dev` or only in a deployed instance.

## Security issues

Do not open a public issue — see [SECURITY.md](SECURITY.md).
