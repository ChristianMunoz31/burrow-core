# Claude-in-Chrome prompts for the Partner Center submission

Ready-to-paste prompts for the Claude in Chrome extension, one per Partner Center submission section of "Burrow: Private Life Organizer" (Store ID 9NT29CNPKBK4). The copy inside each prompt comes from [../MICROSOFT_STORE.md](../MICROSOFT_STORE.md) (section 5, "Draft Store listing", and the policy notes). If the two ever differ, the listing document wins, so edit the prompt.

How to use: sign in to Partner Center yourself in Chrome first, open the app's draft submission, then paste ONE prompt at a time into Claude in Chrome and read its report. Every prompt tells Claude to edit the draft only, click Save draft only, never submit, upload nothing, and stop at any sign-in, MFA or payment page. The Packages section (uploading the .msixbundle) and Submission options (capability justifications, notes for certification) are not covered here: do those yourself.

Before you start, read [../MICROSOFT_STORE.md](../MICROSOFT_STORE.md) "Before the first upload: blocking decisions". The privacy policy URL in the Properties prompt is live (published 2026-10-08), but the page is now version 1.1 (effective 2026-10-09): re-publish it to the `gh-pages` branch of `burrow-releases` before the 1.1.0 Store submission and the direct release.

## 1. Pricing and availability

Price Free, all markets, and the third-party in-app purchase declaration (Gumroad, policy 10.8.2) if the page has it.

````text
You are helping the owner fill in ONE section of a Microsoft Partner Center app submission.
The app is "Burrow: Private Life Organizer" (Store ID 9NT29CNPKBK4). Open it from Partner Center > Apps and games.
Rules, all mandatory:
- Edit the DRAFT submission only. Do not create or change anything outside it.
- Click Save draft only. NEVER click Submit or "Submit to the Store". If a Submit button is the only way forward, stop and say so.
- Do not upload any files.
- If a sign-in, MFA or payment page appears, stop at once and report it. Do not enter credentials or payment details.
- Do not change account settings, the developer profile, tax or payout settings.
- Where the form has no matching field for something below, skip it and say so in your report.
- When done, report exactly what you saved (field by field) and anything you skipped or could not do.

SECTION: Pricing and availability.
1. Price: Free. Do not set any price, sale or trial.
2. Markets: leave all markets selected (all markets).
3. Visibility and schedule: leave the defaults; do not set a publish date.
4. If the page offers a way to declare in-app purchases or third-party purchases, declare them: Burrow Pro is sold by a third party (Gumroad, which is PCI DSS compliant) in the browser, outside the Store, as a one-time purchase; the app only opens the Gumroad page in the default browser. If the form has no such option, skip it and say so.
5. Click Save draft. Do not click Submit.
````

## 2. Properties

Category Productivity, privacy policy URL, support contact, personal information handling and the system requirements note.

````text
You are helping the owner fill in ONE section of a Microsoft Partner Center app submission.
The app is "Burrow: Private Life Organizer" (Store ID 9NT29CNPKBK4). Open it from Partner Center > Apps and games.
Rules, all mandatory:
- Edit the DRAFT submission only. Do not create or change anything outside it.
- Click Save draft only. NEVER click Submit or "Submit to the Store". If a Submit button is the only way forward, stop and say so.
- Do not upload any files.
- If a sign-in, MFA or payment page appears, stop at once and report it. Do not enter credentials or payment details.
- Do not change account settings, the developer profile, tax or payout settings.
- Where the form has no matching field for something below, skip it and say so in your report.
- When done, report exactly what you saved (field by field) and anything you skipped or could not do.

SECTION: Properties.
1. Category: Productivity. Leave any subcategory empty unless one is required.
2. Privacy policy URL: https://christianmunoz31.github.io/burrow-releases/privacy/
   (This page is live. You may open it in a new tab to confirm it loads; do not change anything there.)
3. Support contact info: burrowsupport@gmail.com (an email address is fine; if a URL is required, leave it empty and say so).
4. Personal information handling: declare it per the privacy statement. Burrow collects no personal information: it has no accounts and no telemetry, and the developer receives no data. Data stays in a database on the user's own computer. It contacts the internet only when the user turns on or clicks an optional feature (weather, Oura, Google Sheets import, Ollama on another computer, a bring-your-own cloud AI key, license activation with Gumroad or Lemon Squeezy). The Microsoft Store collects its own data under Microsoft's terms. If the form asks whether the app accesses, collects or transmits personal information, answer in line with this, and list what you chose in your report.
5. System requirements note (use the notes or additional-requirements field if there is one): Windows 10 version 1903 or later, or Windows 11. Windows 10 requires Microsoft Edge WebView2, preinstalled on most PCs. The Javi assistant needs Ollama (free, installed separately from ollama.com) with a model such as llama3.2:3b; everything else works without it.
6. Leave every other field at its current value. Click Save draft. Do not click Submit.
````

## 3. Age ratings (IARC)

Walks the questionnaire with the facts about Burrow and stops before the final confirmation, then summarizes the answers for you to review.

````text
You are helping the owner fill in ONE section of a Microsoft Partner Center app submission.
The app is "Burrow: Private Life Organizer" (Store ID 9NT29CNPKBK4). Open it from Partner Center > Apps and games.
Rules, all mandatory:
- Edit the DRAFT submission only. Do not create or change anything outside it.
- Click Save draft only. NEVER click Submit or "Submit to the Store". If a Submit button is the only way forward, stop and say so.
- Do not upload any files.
- If a sign-in, MFA or payment page appears, stop at once and report it. Do not enter credentials or payment details.
- Do not change account settings, the developer profile, tax or payout settings.
- Where the form has no matching field for something below, skip it and say so in your report.
- When done, report exactly what you saved (field by field) and anything you skipped or could not do.

SECTION: Age ratings (IARC questionnaire). Do NOT reach the final confirmation.
Facts to answer with. Read each question and map the facts to it honestly; do not invent answers and do not choose an answer only to lower the rating.
- Burrow is a personal budget, journal and productivity app. It has no violence, sexual content, nudity, profanity, drugs, alcohol or gambling of its own, and no content from other users.
- Generative AI: YES. The app contains generative AI (Javi, a language model run locally through Ollama). The user opens Javi to get a short insight about the current page; with Burrow Pro the user can also type follow-up questions and get a daily briefing, which Burrow can write on a schedule on this computer. Output is not pre-moderated by the developer and can be wrong or inappropriate. In-app reporting exists (Help > Report content... and the Report link under each Javi reply and under the briefing).
- User-to-user communication: NO. No messaging, forums or sharing between users.
- Sharing of location: NO.
- Digital purchases: YES, external only. Burrow Pro is sold through Gumroad outside the Store; the app opens the Gumroad page in the browser.
- No accounts, no ads, no online play, no personal information collected by the developer.
- Category: pick the one that fits a productivity or utility app (the nearest option if there is no exact match).
Steps: start or continue the questionnaire, answer using only the facts above, and go through to the summary of results. STOP before any final confirmation, "Submit" or "Save" step that would lock in the ratings. Then report: every question you saw with the answer you chose and which fact it came from, the rating the questionnaire shows for each region, and any question you could not answer from these facts (list them for the owner). Do not click Submit.
````

## 4. Store listings (English)

Name, descriptions, features, search terms, What's new and copyright. No screenshots: Claude leaves you a note of the files to upload.

````text
You are helping the owner fill in ONE section of a Microsoft Partner Center app submission.
The app is "Burrow: Private Life Organizer" (Store ID 9NT29CNPKBK4). Open it from Partner Center > Apps and games.
Rules, all mandatory:
- Edit the DRAFT submission only. Do not create or change anything outside it.
- Click Save draft only. NEVER click Submit or "Submit to the Store". If a Submit button is the only way forward, stop and say so.
- Do not upload any files.
- If a sign-in, MFA or payment page appears, stop at once and report it. Do not enter credentials or payment details.
- Do not change account settings, the developer profile, tax or payout settings.
- Where the form has no matching field for something below, skip it and say so in your report.
- When done, report exactly what you saved (field by field) and anything you skipped or could not do.

SECTION: Store listings, English (en-us) only. Do not upload screenshots or any images.
Fill the English listing exactly as follows. Paste the text exactly; do not rewrite it. The lines with <<< and >>> are markers and are not part of the text.

Product name (must stay as reserved): Burrow: Private Life Organizer

Short description:
<<<
A private budget and journal tracker that runs on your own computer. Zero subscriptions. Private by default.
>>>

Description (paste everything between the markers, keep the blank lines):
<<<
Requires Ollama (free, installed separately from ollama.com) for the Javi assistant. Everything else in Burrow works without it.

Generative AI: Javi uses a local generative AI model through Ollama, on your own computer. Its answers can be wrong or inappropriate, so check anything that matters. Under each Javi reply there is a Report link, and Help > Report content... does the same: both open a draft email to the support address, and Burrow sends nothing itself.

Burrow is a private budget and journal tracker for your Windows PC. Your data stays on your computer, in open formats. No accounts, no telemetry, and nothing goes to the cloud unless you choose to turn something on.

- One simple menu for your money and your days: transactions and subscriptions, todos, notes, focus sessions, countdowns, bookmarks and folders, your journal, habits, sleep and activity, a calendar, and the weather in the Javi card on Home.
- Automatic daily local backups with one-click restore, plus an export of everything as open files (JSON, CSV and Markdown).
- Javi, a built-in helper that gives a quick insight about the page you are on, shows a small count when there is something new to look at, and with Burrow Pro answers questions about your own data. All math (totals, averages, budgets) is calculated by Burrow, not by the model.
- Privacy controls you can see: a Network activity page lists recent outbound connections Burrow has made (the last 90 days). Anything that contacts the internet is off until you turn it on.
- Optional: bring your own cloud AI provider. It is off by default and asks for confirmation first.
- Your data is never paywalled. Export, import, backups and privacy controls are free forever.

Price: Burrow is free to download and includes a full 14-day trial of every Pro feature, with no card and no account. Burrow Pro is a one-time purchase sold through Gumroad, a third-party seller, not through the Store. It includes a year of new Pro features (two years for the Founding edition): the Pro features released during that year stay yours forever, and Pro features released after it need a newer Burrow Pro license. Everything in Burrow Free is unaffected. Prices range from $49 (Standard) to $99 (Founding edition, limited-time, on sale until January 5, 2027), with a Family edition for up to 5 people at $79. After you buy, paste the license key in Settings > License. Clicking "Buy Burrow Pro" opens the Gumroad page in your browser.

Windows 10 requires Microsoft Edge WebView2, preinstalled on most PCs.
>>>

Features (one per feature row, in this order):
Budget and journal with todos, habits, notes, focus, calendar, countdowns and bookmarks, in one app
Your data stays on your computer: no account, no telemetry, nothing sent to the cloud by default
Automatic daily backups with one-click restore, and export as JSON, CSV or Markdown
Javi, a built-in helper on your computer (needs Ollama), gives a quick insight on each page and shows when there is something new
Network activity page shows recent outbound connections (kept 90 days); anything that goes online is off until you turn it on
Free to use; Burrow Pro is an optional one-time purchase through Gumroad

Search terms / keywords (one per row, at most 7):
budget tracker
private journal
expense tracker
offline finance
local first
personal finance
privacy

What's new in this version (Burrow 1.2.0):
<<<
New: one simple menu. Home is at the top, then your pages in three groups: Budget (Budget, Subscriptions), Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders) and Health (Journal, Habits, Sleep & activity), with Calendar at the bottom. The Work and Home filter is now on the Todos page, and your tags are kept.
The Health page is now called Sleep & activity. It still shows the readiness, sleep and activity from your Oura Ring.
Home starts with a Javi card: today's briefing with Burrow Pro, otherwise Get insight for a short note about your day.
The weather now shows in the Javi card (turn on Weather in Settings > Network). Calendar is just your events.
Home shows a Budget card with what you spent this month, what you budgeted and what is left.
Next to it, a Subscriptions card shows your next subscription charges in the coming 30 days and what they add up to.
If you never customized Home, it starts with the Javi card and six others. Use Customize to show the rest.
New: a calculator. Press Ctrl+K and choose Calculator.
Javi has a new look: a message bar at the bottom right of your pages that opens upward, where its insight about the page reads like a message from Javi. When a page has something new for Javi, a small count on the bar lets you know. Press Alt+J to open Javi.
A calmer top bar: Burrow takes you Home, the gear opens Settings, and a Back button takes you back to where you were.
>>>

Copyright and trademark info: Neural Foundry

Screenshots: do NOT upload anything. Instead, add this note to your report for the owner: "Screenshots to upload by hand in the Store listings screenshots area: upload ONE set only: the six files ending in -caption.png in %LOCALAPPDATA%\burrow-release\store\screenshots (at least 1; 4 recommended at 1920x1080 or larger). Do not upload the plain files without -caption; they are the uncaptioned originals."
Leave every other field (trailers, additional license terms, app tile art, etc.) unchanged. Click Save draft. Do not click Submit.
````
