# Burrow licensing

Burrow is free of charge for everyone. There is no trial, no license key, no activation, no paid tier and no time limit. Every feature is on for every install of an official build. The decision is recorded in [ADR 0002](adr/0002-free-for-everyone.md) (2026-11-05), which replaced the earlier paid-tier, trial and license-key spec that lived in this file.

## Source licenses

- **The core** is licensed under AGPL-3.0-only. Its source is public at https://github.com/ChristianMunoz31/burrow-core. Anyone may build and run it; a build from the core alone does not include the private module (see below).
- **The private module** (`pro/`, repo `burrow-pro`) is proprietary and its source is not public. It is compiled into the official Burrow builds (the Windows installers and the Microsoft Store package) and is included there at no cost. It is not covered by the AGPL. The end-user terms are in [EULA.md](EULA.md) (a draft that needs legal review).
- **Third-party software** keeps its own licenses. They are listed in `THIRD_PARTY_NOTICES.md`, which ships with each build.

## What a build includes

The only remaining condition is technical: whether the private module is compiled into the build. An official build includes it, so every feature works. A core-only build (`BURROW_PRO=off`, or one made from the public core repository) answers the module's routes with `501 pro_not_included`, and the UI says "This build of Burrow does not include this feature. The official Burrow app includes it at no cost." It never offers to buy, upgrade or start a trial. How the seam works: [OPEN_CORE.md](OPEN_CORE.md).

## Data left by older versions

Older versions stored license, trial and clock records (`license-activation.json`, `license-clock.json`, `license-trial.json`, `license.burrowlicense*`, the `license.*` rows in `app_state` and the `LICENSE_STORE_KEY` secret). Nothing reads them any more. Erase all my data removes them with everything else, and importing a backup skips them. The Burrow app makes no request to any store.

## Dependency license audit

`npm run check:licenses` audits the licenses of the dependencies that ship in the builds. It stays part of the release checks, because the official builds combine an AGPL core with a proprietary module and must not bundle a copyleft third-party dependency (see [PUBLISHING_CORE.md](PUBLISHING_CORE.md)).

## Related

- [adr/0002-free-for-everyone.md](adr/0002-free-for-everyone.md): the decision and what was removed.
- [OPEN_CORE.md](OPEN_CORE.md) and [PUBLISHING_CORE.md](PUBLISHING_CORE.md): the open-core seam and how the core is published.
- [EULA.md](EULA.md): the end-user notice for official builds.
