# Centopus CDK

stacks.ts contains authoritative definitions; config.ts validates inputs; bin/app.ts selects real configuration or explicit offline fixtures. Use root npm ci, not a separate installation here.

- npm run infra:synth: offline fixtures, no deployment.
- npm run infra:diff: actual configured resource comparison; credentials required.
- npm run infra:deploy: explicit deployment after reviewing configuration and diff.

See [scope and prerequisites](../README.md). Generated assemblies are not source. Historical foundation CDK targets a different storage/runtime contract and must not be mixed into these stacks.
