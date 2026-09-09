# Contributing

Before submitting a change:

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Adapter changes should include an official-documentation fixture or link and a round-trip test. Preserve unknown native fields in target overlays. Never translate a permission unless the output is demonstrably no more permissive than the input.

Keep tests synthetic. Do not copy a real `~/.claude`, `~/.codex`, `.gemini`, token, transcript, private repository URL, or personal harness into a fixture.
