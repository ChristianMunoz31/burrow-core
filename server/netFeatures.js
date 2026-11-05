// The outbound-network feature registry as plain data: no imports, so the server, the tests and
// the privacy page generator (scripts/privacy/renderPrivacy.mjs) all read one copy. The Settings >
// Network page shows id, label, description and hosts (through server/netPolicy.js). `policy` is
// the extra plain-language detail the published privacy page prints per feature: what is sent and
// when. Change a feature here and run `npm run privacy:render`; `npm run check:privacy` fails
// while the committed pages/ output is out of date.

/** Fixed order: this is the order the settings API returns. */
export const NETWORK_FEATURES = Object.freeze([
  Object.freeze({
    id: 'weather',
    label: 'Weather',
    description: 'Fetches the forecast for your coordinates from Open-Meteo. Your latitude and longitude are sent.',
    hosts: Object.freeze(['api.open-meteo.com']),
    policy: Object.freeze({
      sent: 'Your latitude and longitude, rounded to 2 decimals (about 1 km).',
      when: "Only while Weather is turned on in Settings > Network, when Burrow loads the forecast, including for Javi's daily briefing.",
    }),
  }),
  Object.freeze({
    id: 'oura',
    label: 'Oura Ring',
    description: 'Pulls sleep, readiness and activity from your Oura account using your personal token. Also lets you test a saved token.',
    hosts: Object.freeze(['api.ouraring.com']),
    policy: Object.freeze({
      sent: 'Your Oura personal token, so Oura can return your sleep, readiness and activity.',
      when: 'Only while Oura Ring is turned on in Settings > Network, when Burrow reads your Oura data or when you test a saved token.',
    }),
  }),
  Object.freeze({
    id: 'sheets',
    label: 'Google Sheets import',
    description:
      'Lets you import transactions from a published Google Sheet link on the Budget page. Burrow only contacts Google (docs.google.com and googleusercontent.com) when you paste a link and choose Load sheet.',
    hosts: Object.freeze(['docs.google.com', '*.googleusercontent.com']),
    policy: Object.freeze({
      sent: 'A request for the published sheet link you pasted. Nothing else from Burrow.',
      when: 'Only when you paste a link and click Load sheet.',
    }),
  }),
  Object.freeze({
    id: 'cloudAi',
    label: 'Cloud AI provider',
    description: 'Use a cloud AI provider (sends data off your computer). Prompts and the data Javi reads go to the endpoint you set.',
    hosts: Object.freeze(['the endpoint you set in Settings > AI']),
    policy: Object.freeze({
      sent: 'Your prompts and the data Javi reads, limited to the data categories you allow, and your own API key as the credential. Data that has no category (weather results, and the advice Javi gives on the Settings page) is not limited by those choices and can be sent whenever cloud AI is on.',
      when: 'Only after you choose a cloud provider in Settings > AI, save its address, model and key, and accept the two-checkbox consent there. Accepting the consent turns this on; you can switch it off again in Settings > Network. It is off by default.',
    }),
  }),
  Object.freeze({
    id: 'aiLan',
    label: 'Ollama on another computer',
    description: 'Use an Ollama server on another computer. Prompts and the data Javi reads go to that computer.',
    hosts: Object.freeze(['the Ollama address you set in Settings > AI']),
    policy: Object.freeze({
      sent: 'Your prompts and the data Javi reads, to the computer you named.',
      when: 'Only after you set that address in Settings > AI and turn this on in Settings > Network. It is off by default.',
    }),
  }),
  Object.freeze({
    id: 'updates',
    label: 'Update check',
    description:
      "Checks GitHub for a newer Burrow when you click Check now in Settings > Updates, or when you open Settings while this is on, and shows what's new. Nothing is downloaded until you click Download and install. Then Burrow saves a backup, and the Burrow app downloads the installer from GitHub, checks its signature and restarts to install it. A copy that can't install updates by itself shows the installer's checksum from GitHub instead: when you click Get the installer, Burrow reads the checksum file (SHA256SUMS.txt) from GitHub and saves a backup, and your browser downloads the installer. Nothing about you or your data is sent; GitHub sees your IP address like any website.",
    hosts: Object.freeze(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'api.github.com']),
    policy: Object.freeze({
      sent: 'Nothing about you or your data. GitHub sees your IP address, like any website you visit.',
      when: 'Only after you turn it on in Settings > Updates or Settings > Network, or click Check now, which turns it on. Then Burrow checks when you open Settings or click Check now. A desktop app that can install updates by itself asks github.com (the latest.json file). Every other stable copy asks api.github.com (the latest release): that includes the direct download desktop app until in-app install is turned on for it, and a copy you run yourself in a browser, in Docker or with npm start. Clicking Get the installer also reads SHA256SUMS.txt from github.com. Burrow Dev and the Microsoft Store edition make no update request.',
    }),
  }),
  Object.freeze({
    id: 'license',
    label: 'License activation',
    description:
      'Contacts Gumroad or Lemon Squeezy only when you click Activate or Move to another computer in Settings > License. Your license key goes to the store you bought from. Clicking one of those buttons turns this on.',
    hosts: Object.freeze(['api.gumroad.com', 'api.lemonsqueezy.com']),
    policy: Object.freeze({
      sent: 'Your license key, the Burrow product id and the setting increment_uses_count=true, which counts this activation (Gumroad), or your license key and the instance name Burrow, or the instance id for a move (Lemon Squeezy). Each request carries the header User-Agent: Burrow. The store also sees your IP address.',
      when: 'Only when you click Activate or Move to another computer in Settings > License. Burrow never re-checks a license in the background.',
    }),
  }),
]);
