/**
 * @file
 * Reading a zip file, which is how a plugin travels.
 *
 * Bun can read tar and tar.gz on its own, through Bun.Archive, and
 * cannot read zip: a file beginning "PK\x03\x04" comes back as an
 * unrecognised format. Zip is worth the forty lines anyway.
 *
 * It has a central directory, so the manifest can be read without
 * inflating everything else — which matters when the installer is
 * listing what is available rather than loading one thing. And it is
 * the format everyone already has a tool for: a plugin is still an
 * ordinary zip under a different extension, so "unzip -l thing.ccp"
 * works when somebody is trying to work out what they were sent.
 *
 * Only deflate and stored entries are handled, which is everything
 * any ordinary zip tool produces. Encrypted and multi-volume archives
 * are refused rather than half-read.
 */
import { inflateRawSync } from "node:zlib";

// The signatures that mark each kind of record
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

// The compression methods worth supporting
const STORED = 0;
const DEFLATED = 8;

// Set in a header's general purpose flags when an entry is encrypted
const ENCRYPTED = 0x0001;

// The end record is 22 bytes plus a comment of up to 64KB
const END_RECORD_SIZE = 22;
const MAX_COMMENT = 0xffff;

/**
 * One file in the archive.
 */
export interface ZipEntry {
  path: string;
  contents: Uint8Array;
}

/**
 * Read every file out of a zip.
 *
 * @param bytes
 * @param origin what to name in errors
 * @returns
 */
export function readZip(bytes: Uint8Array, origin: string): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(view, bytes.length, origin);

  const count = view.getUint16(end + 10, true);
  const entries: ZipEntry[] = [];

  let at = view.getUint32(end + 16, true);

  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_FILE_HEADER) {
      throw new Error(`${origin} has a damaged central directory at entry ${index + 1}.`);
    }

    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);

    const path = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // Directories are entries too, and carry nothing
    if (!path.endsWith("/")) {
      if ((flags & ENCRYPTED) !== 0) {
        throw new Error(
          `${origin} is encrypted, and this doesn't decrypt archives. Package a plugin without a password.`,
        );
      }

      entries.push({
        path,
        contents: readEntry(bytes, view, localAt, method, compressedSize, uncompressedSize, path, origin),
      });
    }

    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Find the end of central directory record, which is the only thing
 * in a zip whose position can be worked out — everything else is
 * found through it.
 *
 * It sits at the end, behind a comment nobody records the length of,
 * so it is found by scanning backwards for its signature.
 *
 * @param view
 * @param length
 * @param origin
 * @returns
 */
function findEndRecord(view: DataView, length: number, origin: string): number {
  if (length < END_RECORD_SIZE) {
    throw new Error(`${origin} is too small to be a zip file.`);
  }

  const earliest = Math.max(0, length - END_RECORD_SIZE - MAX_COMMENT);

  for (let at = length - END_RECORD_SIZE; at >= earliest; at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
      // A multi-volume archive says so here, and reading one volume of
      // it would silently produce a plugin missing half its files
      if (view.getUint16(at + 4, true) !== 0 || view.getUint16(at + 6, true) !== 0) {
        throw new Error(`${origin} is one volume of a split archive. Package a plugin as a single file.`);
      }

      return at;
    }
  }

  throw new Error(
    `${origin} isn't a zip file. A plugin is a zip archive, whatever extension it carries.`,
  );
}

/**
 * Pull one entry's bytes out, following the offset the central
 * directory gave.
 *
 * The local header repeats the name and carries its own extra field,
 * and the two extra fields are frequently different lengths, so the
 * data offset has to be worked out from the local header rather than
 * assumed from the central one.
 *
 * @returns
 */
function readEntry(
  bytes: Uint8Array,
  view: DataView,
  localAt: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
  path: string,
  origin: string,
): Uint8Array {
  if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== LOCAL_FILE_HEADER) {
    throw new Error(`${origin} points at "${path}" from its directory and there's nothing there.`);
  }

  const nameLength = view.getUint16(localAt + 26, true);
  const extraLength = view.getUint16(localAt + 28, true);
  const from = localAt + 30 + nameLength + extraLength;
  const raw = bytes.subarray(from, from + compressedSize);

  if (from + compressedSize > bytes.length) {
    throw new Error(`${origin} is truncated: "${path}" runs past the end of the file.`);
  }

  if (method === STORED) {
    return raw;
  }

  if (method !== DEFLATED) {
    throw new Error(
      `"${path}" in ${origin} uses compression method ${method}, and only stored and deflated entries are read. Package a plugin with an ordinary zip tool.`,
    );
  }

  const inflated = new Uint8Array(inflateRawSync(raw));

  // The directory says how big it should be, so a mismatch means the
  // archive is damaged rather than merely unexpected
  if (inflated.length !== uncompressedSize) {
    throw new Error(
      `"${path}" in ${origin} unpacked to ${inflated.length} bytes where the archive says ${uncompressedSize}. The file is damaged.`,
    );
  }

  return inflated;
}
