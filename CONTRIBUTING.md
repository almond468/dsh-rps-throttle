# Contributing to dsh-rps-throttle

Thank you for considering contributing!

## Development Setup

```bash
git clone https://github.com/<your-org>/dsh-rps-throttle.git
cd dsh-rps-throttle

# Syntax check
node --check lib/index.js

# Run self-tests (offline, no network)
node test/selftest.mjs
```

## Code Style

- ESM modules (`"type": "module"`)
- No external dependencies (zero `import`/`require` of third-party packages)
- Comments in English
- JSDoc for exported functions and non-obvious internals
- Keep the code self-contained: no filesystem, no network, no timers except for heartbeat/logging (which are guarded with `.unref?.()`)

## Testing

The self-test (`test/selftest.mjs`) is fully offline and covers:
1. Rate pacing + per-model bucketing + rps-type 429 inline handling
2. RPM quota wall: 0 inline retries + cooldown activation
3. RPM=3/3s sliding window: first 3 pass, next 3 queue at ~3s intervals

Run before submitting any change:
```bash
node test/selftest.mjs
```

## Pull Requests

1. Fork and create a feature branch
2. Ensure `node --check lib/index.js` passes
3. Ensure `node test/selftest.mjs` passes
4. Update README.md if behavior or config changes
5. Submit PR with a clear description of the change

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
