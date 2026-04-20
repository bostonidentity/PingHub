# PingHub

Open-source tooling for working with [Ping Advanced Identity Cloud](https://www.pingidentity.com/en/platform/capabilities/advanced-identity-cloud.html) (AIC), maintained by [Boston Identity](https://bostonidentity.com).

PingHub is a monorepo. Each top-level directory is an independent project with its own README, dependencies, and release cadence.

## Projects

| Project | Description |
|---|---|
| [`aic-pipeline/`](./aic-pipeline) | Web UI for AIC tenant config management — pull, push, and promote configs across environments with a guided diff-review workflow. |

More projects will be added to this monorepo over time.

## Repository layout

```
PingHub/
  aic-pipeline/          # AIC config pipeline UI (Next.js)
  LICENSE                # Apache 2.0 — applies to every project in this repo
  NOTICE                 # Third-party attribution (applies to the whole repo)
  SECURITY.md            # How to report vulnerabilities privately
  CODE_OF_CONDUCT.md     # Community conduct standards
```

## License

Every project in this repository is licensed under the [Apache License, Version 2.0](./LICENSE). See [NOTICE](./NOTICE) for third-party attribution.

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).

## Community

- Issues: https://github.com/bostonidentity/PingHub/issues
- Discussions: https://github.com/bostonidentity/PingHub/discussions

By participating in this project you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).
