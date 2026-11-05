// Local test signing only. A package for the Microsoft Store is NOT signed by us: the Store re-signs it. To sideload a
// test package on this PC it must be signed by a certificate whose subject equals the package Publisher (the real
// Partner Center Publisher once config/msstore.json is filled), and that certificate must be trusted. This creates or
// reuses a short-lived self-signed one in the current user's store (never in the repo, no private key is exported),
// writes its public .cer next to the packages, and signs with signtool.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const LOCAL_TEST_CERT_DAYS = 30;
// Object identifiers, written as numbers so they are not mistaken for IP addresses: code signing EKU and basic constraints (not a CA).
const CODE_SIGNING_EKU = [1, 3, 6, 1, 5, 5, 7, 3, 3].join('.');
const BASIC_CONSTRAINTS = [2, 5, 29, 19].join('.');
const THUMBPRINT_RE = /^[0-9A-F]{40}$/;

// The subject and the .cer path reach PowerShell through these environment variables, never through string quoting in
// the script text, so no value can end up as PowerShell code.
export const SUBJECT_ENV = 'BURROW_TEST_CERT_SUBJECT';
export const CER_PATH_ENV = 'BURROW_TEST_CERT_CER_PATH';

/**
 * PowerShell that finds or creates the test certificate, exports the public part and prints its thumbprint. It reads the
 * subject and the .cer path from the environment (SUBJECT_ENV, CER_PATH_ENV). The private key is created NonExportable.
 */
export function certScript({ days = LOCAL_TEST_CERT_DAYS } = {}) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$subject = $env:${SUBJECT_ENV}`,
    `$cerPath = $env:${CER_PATH_ENV}`,
    'if (-not $subject -or -not $cerPath) { throw "missing certificate subject or output path" }',
    '$cert = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq $subject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(2) } | Sort-Object NotAfter -Descending | Select-Object -First 1',
    'if (-not $cert) {',
    `  $cert = New-SelfSignedCertificate -Type Custom -Subject $subject -KeyUsage DigitalSignature -KeyExportPolicy NonExportable -FriendlyName "Burrow local MSIX test" -CertStoreLocation "Cert:\\CurrentUser\\My" -NotAfter (Get-Date).AddDays(${Number(days)}) -TextExtension @("${[2, 5, 29, 37].join('.')}={text}${CODE_SIGNING_EKU}", "${BASIC_CONSTRAINTS}={text}")`,
    '}',
    'Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null',
    'Write-Output $cert.Thumbprint',
  ].join('\n');
}

/**
 * @param {string} stdout output of the cert script
 * @returns {string} the thumbprint
 * @throws {Error} when no thumbprint is in the output
 */
export function parseThumbprint(stdout) {
  const last = String(stdout).trim().split(/\r?\n/).pop()?.trim().toUpperCase() ?? '';
  if (!THUMBPRINT_RE.test(last)) throw new Error('Could not read the certificate thumbprint from PowerShell');
  return last;
}

/**
 * Creates (or reuses) the local test certificate for `subject` and exports its public .cer.
 * @param {{ outDir: string, subject: string, run?: typeof execFileSync }} opts `subject` must equal the package Publisher
 * @returns {{ thumbprint: string, cerPath: string }}
 */
export function ensureLocalTestCert({ outDir, subject, run = execFileSync }) {
  if (typeof subject !== 'string' || !subject.startsWith('CN=')) throw new Error('The test certificate subject must be the package Publisher (CN=...)');
  const cerPath = path.join(outDir, 'BurrowLocalTest.cer');
  const stdout = run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', certScript()], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, [SUBJECT_ENV]: subject, [CER_PATH_ENV]: cerPath },
  });
  return { thumbprint: parseThumbprint(stdout), cerPath };
}

/**
 * Arguments for `signtool sign` with a certificate from the current user's store (SHA-256, no timestamp: a local
 * test package needs none).
 * @param {{ thumbprint: string, file: string }} opts
 * @returns {string[]}
 */
export function signtoolArgs({ thumbprint, file }) {
  if (!THUMBPRINT_RE.test(thumbprint)) throw new Error('Invalid certificate thumbprint');
  return ['sign', '/fd', 'SHA256', '/sha1', thumbprint, '/s', 'My', file];
}

/**
 * Signs files with signtool.
 * @param {{ signtool: string, thumbprint: string, files: string[], run?: typeof execFileSync }} opts
 */
export function signFiles({ signtool, thumbprint, files, run = execFileSync }) {
  for (const file of files) run(signtool, signtoolArgs({ thumbprint, file }), { stdio: 'inherit', windowsHide: true });
}
