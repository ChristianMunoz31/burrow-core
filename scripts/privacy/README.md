# Privacy policy pages

`pages/` is generated. Never edit it by hand.

- Source of truth: `server/netFeatures.js` (the registry behind Settings > Network), `config/store.json` (`supportContact`) and `config/privacy.json` (policy version and effective date).
- Regenerate: `npm run privacy:render`. Verify: `npm run check:privacy` (part of `npm run check`). It fails when `pages/` differs from a fresh render or when a feature id or host is missing from the page.
- When you add or change a network feature, update its `policy` text in `server/netFeatures.js`, bump `config/privacy.json` if the policy meaning changed, and re-render.

## Publish (owner steps, PowerShell)

The public repo `ChristianMunoz31/burrow-releases` only receives installers by way of `publishPublic.js`, which uploads release assets and never touches git branches. Publish the pages on a separate `gh-pages` branch so main and the releases stay untouched.

```powershell
# 1. Clone the public repo somewhere outside this repo.
git clone https://github.com/ChristianMunoz31/burrow-releases.git "$env:TEMP\burrow-releases"
Set-Location "$env:TEMP\burrow-releases"

# 2. Create an orphan gh-pages branch holding only the site.
git checkout --orphan gh-pages
git rm -rf . 2>$null
Copy-Item -Recurse -Force "<burrow checkout>pages*" .
Copy-Item -Force "<burrow checkout>pages.nojekyll" .
git add -A
git commit -m "docs(privacy): publish the Burrow privacy policy"

# 3. Push (this is the first public change).
git push -u origin gh-pages
```

Replace <burrow checkout> with the folder that holds the merged `pages/` directory.

4. On GitHub open `burrow-releases` > Settings > Pages. Under Build and deployment choose Source: Deploy from a branch, Branch: `gh-pages`, Folder: `/ (root)`, then Save.
5. Wait a minute, then open https://christianmunoz31.github.io/burrow-releases/privacy/ and check it loads, shows the effective date and lists seven features. Paste that URL in Partner Center (Properties > privacy policy URL) and record it in docs/MICROSOFT_STORE.md.

To update later: run `npm run privacy:render` here, commit, then repeat step 2 on the `gh-pages` branch (check it out, replace the files, commit, push).
