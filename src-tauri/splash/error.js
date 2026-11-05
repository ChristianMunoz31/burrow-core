// Shows the server log path passed as ?log=... (set with textContent, never as HTML).
const log = new URLSearchParams(window.location.search).get('log');
const el = document.getElementById('log');
if (el) el.textContent = log || '(log location unavailable)';
