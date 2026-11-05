// Small PE (Windows executable) helpers for the Store build.
//
// Why strip a signature: the sidecar is an official node.exe with the Burrow server injected by postject. node.exe
// ships Authenticode-signed; the injection rewrites the file, so the embedded signature no longer matches
// (postject warns "The signature seems corrupted!"). `signtool sign` on an .msix that contains such a file fails with
// 0x800700C1 (ERROR_BAD_EXE_FORMAT), and the Store signs the package the same way after upload. An unsigned exe is fine
// inside an MSIX (the package signature covers every file), so the dead signature is removed from the packaged copy.

const MZ = 0x5a4d;
const PE_MAGIC32 = 0x10b;
const PE_MAGIC64 = 0x20b;
const SECURITY_DIRECTORY = 4;
const SECTION_HEADER_SIZE = 40;

/**
 * @param {Buffer} bytes
 * @returns {{ peOffset: number, optionalOffset: number, machine: number, directoriesOffset: number, directoryCount: number } | null}
 */
function readHeaders(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== MZ) return null;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length || bytes.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return null;
  const optionalOffset = peOffset + 24;
  if (optionalOffset + 2 > bytes.length) return null;
  const magic = bytes.readUInt16LE(optionalOffset);
  const directoriesOffset = optionalOffset + (magic === PE_MAGIC64 ? 112 : magic === PE_MAGIC32 ? 96 : -1);
  if (directoriesOffset < optionalOffset || directoriesOffset + 8 * 16 > bytes.length) return null;
  // NumberOfRvaAndSizes sits right before the data directories (PE32+: optional header offset 108, PE32: 92).
  const directoryCount = bytes.readUInt32LE(directoriesOffset - 4);
  return { peOffset, optionalOffset, machine: bytes.readUInt16LE(peOffset + 4), directoriesOffset, directoryCount };
}

/**
 * End of the raw data of the last section (max PointerToRawData + SizeOfRawData), or null when the section table does
 * not fit in the file.
 * @param {Buffer} bytes
 * @param {{ peOffset: number, optionalOffset: number }} headers
 * @returns {number | null}
 */
function sectionsEnd(bytes, { peOffset, optionalOffset }) {
  const count = bytes.readUInt16LE(peOffset + 6);
  const table = optionalOffset + bytes.readUInt16LE(peOffset + 20);
  if (table + count * SECTION_HEADER_SIZE > bytes.length) return null;
  let end = 0;
  for (let i = 0; i < count; i += 1) {
    const header = table + i * SECTION_HEADER_SIZE;
    end = Math.max(end, bytes.readUInt32LE(header + 20) + bytes.readUInt32LE(header + 16));
  }
  return end;
}

/**
 * Machine type from the PE header of an executable.
 * @param {Buffer} bytes at least the first 4 KiB of the file
 * @returns {'x64' | 'arm64' | 'other' | null} null when this is not a PE file
 */
export function peMachine(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== MZ) return null;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return null;
  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine === 0x8664) return 'x64';
  if (machine === 0xaa64) return 'arm64';
  return 'other';
}

/**
 * Removes the embedded Authenticode signature of a PE file: clears the Security data directory, zeroes the header
 * checksum and, only when the certificate table is the last thing in the file (it starts at or after the end of the last
 * section's raw data and ends exactly at the end of the file, where signers put it), cuts it off. Otherwise the file
 * keeps its length, so no section or overlay data can be lost to a misread header.
 * Anything that is not a PE file with a signature, or that has no Security data directory (NumberOfRvaAndSizes of 4 or
 * less), is returned unchanged.
 * @param {Buffer} bytes
 * @returns {{ bytes: Buffer, stripped: boolean }}
 */
export function stripPeSignature(bytes) {
  const headers = readHeaders(bytes);
  if (!headers || headers.directoryCount <= SECURITY_DIRECTORY) return { bytes, stripped: false };
  const entry = headers.directoriesOffset + SECURITY_DIRECTORY * 8;
  const offset = bytes.readUInt32LE(entry);
  const size = bytes.readUInt32LE(entry + 4);
  if (offset === 0 && size === 0) return { bytes, stripped: false };
  const out = Buffer.from(bytes);
  out.writeUInt32LE(0, entry);
  out.writeUInt32LE(0, entry + 4);
  out.writeUInt32LE(0, headers.optionalOffset + 64);
  const end = sectionsEnd(bytes, headers);
  const trailing = offset > 0 && end !== null && offset >= end && offset + size === out.length;
  const cut = trailing ? out.subarray(0, offset) : out;
  return { bytes: Buffer.from(cut), stripped: true };
}

/**
 * Size and offset of the embedded signature, for tests and logs.
 * @param {Buffer} bytes
 * @returns {{ offset: number, size: number } | null} null when not a PE file
 */
export function peSignature(bytes) {
  const headers = readHeaders(bytes);
  if (!headers) return null;
  const entry = headers.directoriesOffset + SECURITY_DIRECTORY * 8;
  return { offset: bytes.readUInt32LE(entry), size: bytes.readUInt32LE(entry + 4) };
}
