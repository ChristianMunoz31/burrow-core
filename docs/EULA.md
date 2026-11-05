# Burrow end-user license notice for official builds

> **Draft, needs legal review. Not in force.** This text is a starting point for the owner and a lawyer. Do not ship it, link it or quote it in public copy until it has been reviewed. Preconditions before first use: the dependency license audit run by Team S (ADR R13, `THIRD_PARTY_NOTICES.md` and `npm ls --omit=dev --all`: no GPL, AGPL or LGPL package in the shipped bundles) is clean, and the owner has reviewed this draft. See [PUBLISHING_CORE.md](PUBLISHING_CORE.md).

Applies to official Burrow builds (the Windows installers and the Microsoft Store package) that combine two parts:

1. **Burrow core**, which is planned to be licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only), with a source offer once the public core repository exists.
2. **The private Burrow module**, which is proprietary software, shipped only compiled inside official builds, at no cost.

Burrow is made by the Burrow authors ("we"). "You" is the person who installs or uses Burrow.

## 1. Burrow core

The core is licensed to you under AGPL-3.0-only. Once the owner has published the core repository, this notice will say where to get the source of the core in each official build, and that offer covers the core only. Nothing in this notice limits the rights the AGPL gives you for the core. Before the public repository exists, the core is not published and this section is a plan.

## 2. The private module

The private module (the `pro/` code) is not covered by the AGPL. We keep all rights in it.

- You may use the module only as part of an official Burrow build, on the terms of this notice.
- You may not copy, extract, redistribute, sublicense, rent, reverse engineer or modify the Pro module, except where the law gives you that right regardless of this notice.
- The module is not redistributable. If you build Burrow from the published core source, you get a build without the module. It still works and keeps all of your data.
- The module can only use the public, audited core APIs. This rule is enforced in our build.

## 3. Price

The app, including the proprietary module in official builds, is provided free of charge. There is no trial, no license key, no activation and no time limit, and every feature is on in every official build. The module remains proprietary software and is not licensed under the AGPL (section 2). In a build made from the published core source alone, the app says that the build does not include some features and that the official Burrow app includes them at no cost. See [LICENSING.md](LICENSING.md) and [adr/0002-free-for-everyone.md](adr/0002-free-for-everyone.md).

## 4. Your data is never paywalled

Your data is yours. Export, import, backups and privacy controls are free in every build and stay free, with or without the proprietary module.

## 5. No warranty and liability

The software is provided "as is", without warranty of any kind, to the extent the law allows. The core's warranty disclaimer is in the AGPL. To the extent the law allows, we are not liable for indirect or consequential loss, and, because the software is provided free of charge, our total liability for the proprietary module is limited to the extent the law allows. Your statutory consumer rights are not affected.

## 6. Third-party software

Burrow includes third-party components under their own licenses. They are listed in `THIRD_PARTY_NOTICES.md`, which ships with each build.

## 7. Open items for the legal review

- Governing law, venue and the notice contact address.
- The wording of the liability limit and the consumer-rights clause for each region sold to.
- Whether the Microsoft Store standard application license terms need a supplement.
- Whether the AGPL source offer needs to appear in the installer, in Settings, or both, and its exact text after the public repo exists.
- Confirmation from the dependency license audit that no copyleft dependency is statically bundled in the shipped builds (ADR R13).
