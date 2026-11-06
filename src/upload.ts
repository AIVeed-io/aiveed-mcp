// Local file -> POST /v1/uploads, for the stdio server only (a hosted server must never read its
// own disk on a caller's behalf). Uploaded media gets a public URL, so a prompt-injected agent must
// not be able to use this tool to publish a file the user did not mean to share. A file is sent
// only if it passes every check:
//   - a local absolute path (no network or device paths, which Windows would open over SMB), with
//     no hidden (dot) directory or file on the way once symlinks are resolved: ~/.ssh, ~/.config,
//     ~/.aws and the like are never read, even for a real image;
//   - not under a system directory (/proc, /sys, /dev, /etc and friends);
//   - inside one of the folders the user listed in AIVEED_MCP_UPLOAD_DIRS. Nothing is uploaded
//     until that is set: the agent cannot set it, so the user decides which folders are shareable;
//   - a regular file with a single link (a hard link would bypass the folder rules), within the
//     API's size cap, with an allowed extension and a structurally valid media layout, so a renamed
//     secret (id_ed25519.png) or text file is refused by its content.
// The checks run on one opened file descriptor, so the file cannot be swapped between the checks
// and the read. Content checks cannot stop a file crafted to look like media by something that can
// write into an allowed folder: that is why the folders are opt-in and should hold media only.
// Path and folder refusals share one message with "not found", so the tool cannot be used to probe
// which files exist.

import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';

export type UploadKind = 'image' | 'audio' | 'video';

// The public API's upload caps and accepted types (see the API reference for /v1/uploads).
const SIZE_CAPS: Record<UploadKind, number> = { image: 10 * 1024 * 1024, audio: 5 * 1024 * 1024, video: 50 * 1024 * 1024 };
const TYPES: Record<UploadKind, Record<string, string>> = {
  image: { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif' },
  audio: { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.ogg': 'audio/ogg' },
  video: { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.webm': 'video/webm', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg' },
};

const ascii = (b: Buffer, start: number, s: string) => b.subarray(start, start + s.length).toString('latin1') === s;
// RIFF (wav, avi, webp): the form type, and a RIFF size that accounts for the whole file (an odd
// size is padded to even).
const printable4 = (b: Buffer, at: number) => [...b.subarray(at, at + 4)].every((x) => x >= 0x20 && x < 0x7f);
const riff = (b: Buffer, form: string) =>
  b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, form) && [b.length - 8, b.length - 9].includes(b.readUInt32LE(4));


// ISO BMFF (mp4, mov, m4a, avif): an "ftyp" box first, then top-level boxes whose sizes chain
// exactly to the end of the file, each with a printable four-character type, including the media
// box the format needs (moov for mp4/mov/m4a, meta for avif).
function isoBmff(b: Buffer, needs: string[]): boolean {
  if (b.length < 16 || !ascii(b, 4, 'ftyp') || !printable4(b, 8)) return false;
  const types = new Set<string>();
  let at = 0;
  while (at < b.length) {
    if (at + 8 > b.length) return false;
    let size = b.readUInt32BE(at);
    const type = b.subarray(at + 4, at + 8).toString('latin1');
    if (!printable4(b, at + 4)) return false;
    if (size === 1) {
      if (at + 16 > b.length) return false;
      const big = b.readBigUInt64BE(at + 8);
      if (big > BigInt(b.length - at)) return false;
      size = Number(big);
    } else if (size === 0) {
      size = b.length - at; // last box runs to the end of the file
    }
    if (size < 8 || at + size > b.length) return false;
    types.add(type);
    at += size;
  }
  return needs.some((t) => types.has(t));
}

// MPEG audio (mp3): a frame header is accepted only if its fields are valid AND the next frame
// header sits exactly where this frame's length says it should. One plausible header is easy to
// hit by accident (a UTF-16 text file starts FF FE); two chained ones are not.
const BITRATES: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Length in bytes of the MPEG audio frame starting at `at`, or 0 if no valid header is there. */
function mpegFrameLength(b: Buffer, at: number): number {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return 0;
  const version = (b[at + 1] >> 3) & 3; // 3 = MPEG 1, 2 = MPEG 2, 0 = MPEG 2.5, 1 reserved
  const layer = 4 - ((b[at + 1] >> 1) & 3); // 1, 2, 3; 4 means reserved
  const bitrateIndex = b[at + 2] >> 4;
  const rateIndex = (b[at + 2] >> 2) & 3;
  if (version === 1 || layer === 4 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0;
  const bitrate = BITRATES[version === 3 ? `1-${layer}` : layer === 1 ? '2-1' : '2-2'][bitrateIndex] * 1000;
  const rate = SAMPLE_RATES[version][rateIndex];
  const padding = (b[at + 2] >> 1) & 1;
  if (layer === 1) return (Math.floor((12 * bitrate) / rate) + padding) * 4;
  return Math.floor(((layer === 3 && version !== 3 ? 72 : 144) * bitrate) / rate) + padding;
}
// Frames chain from `at`: each header valid and the next one exactly where its length says. The
// last frame may be cut short, and an ID3v1 tag ("TAG", 128 bytes) and/or an APE tag footer may
// follow. Anything else after the frames is refused, so no text can ride along at the end.
function mpegFramesToEnd(b: Buffer, at: number, frameLength: (b: Buffer, at: number) => number): boolean {
  let frames = 0;
  for (;;) {
    const len = frameLength(b, at);
    if (len < 7 && len !== 0) return false;
    if (len === 0) break;
    if (at + len > b.length) return frames > 0; // truncated last frame
    at += len;
    frames++;
  }
  if (frames < 2 && at !== b.length) return false;
  let rest = b.subarray(at);
  if (rest.length >= 128 && ascii(rest, rest.length - 128, 'TAG')) rest = rest.subarray(0, rest.length - 128);
  if (rest.length >= 32 && ascii(rest, rest.length - 32, 'APETAGEX')) rest = rest.subarray(0, rest.length - 32);
  if (rest.length > 0 && ascii(rest, 0, 'APETAGEX')) rest = Buffer.alloc(0); // APE tag with header
  return frames >= 1 && rest.length === 0;
}

// An ID3v2 tag: "ID3", version 2-4, a revision, flags, a 4-byte size of 7-bit bytes; the MPEG
// audio frames follow it (after a 10-byte footer when flag 0x10 is set), allowing for padding
// some encoders leave before the first frame.
function mp3(b: Buffer): boolean {
  if (!ascii(b, 0, 'ID3')) return mpegFramesToEnd(b, 0, mpegFrameLength);
  if (b[3] < 2 || b[3] > 4 || b[4] === 0xff) return false;
  const size = b.subarray(6, 10);
  if (size.length < 4 || size.some((x) => x >= 0x80)) return false;
  const end = 10 + ((size[0] << 21) | (size[1] << 14) | (size[2] << 7) | size[3]) + (b[5] & 0x10 ? 10 : 0);
  for (let at = end; at < Math.min(b.length - 1, end + 4096); at++) {
    if (b[at] === 0xff && mpegFrameLength(b, at) > 0) return mpegFramesToEnd(b, at, mpegFrameLength);
    if (b[at] !== 0) return false; // only zero padding between the tag and the first frame
  }
  return false;
}

// AAC in ADTS frames, with the 13-bit frame length in each header.
function adtsFrameLength(b: Buffer, at: number): number {
  if (at + 7 > b.length || b[at] !== 0xff || (b[at + 1] & 0xf6) !== 0xf0) return 0;
  if (((b[at + 2] >> 2) & 0x0f) > 12) return 0; // sampling frequency index
  const len = ((b[at + 3] & 0x03) << 11) | (b[at + 4] << 3) | (b[at + 5] >> 5);
  return len >= 7 ? len : 0;
}

// CRC-32 (PNG: reflected 0xEDB88320) and Ogg's CRC (non-reflected 0x04C11DB7), table-driven.
const PNG_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function pngCrc(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = PNG_CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const OGG_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});
function oggCrc(b: Buffer): number {
  let c = 0;
  for (const x of b) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ x) & 0xff]) >>> 0;
  return c >>> 0;
}

// PNG: the signature, then chunks to the very end, each with a valid CRC: IHDR first, at least one
// IDAT, IEND last and nothing after it.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPng(b: Buffer): boolean {
  if (b.length < 8 + 25 + 12 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let at = 8;
  let first = true;
  let idat = false;
  while (at + 12 <= b.length) {
    const len = b.readUInt32BE(at);
    if (len > b.length - at - 12) return false;
    const type = b.subarray(at + 4, at + 8);
    if (![...type].every((x) => (x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a))) return false;
    if (pngCrc(b.subarray(at + 4, at + 8 + len)) !== b.readUInt32BE(at + 8 + len)) return false;
    const name = type.toString('latin1');
    if (first && (name !== 'IHDR' || len !== 13)) return false;
    first = false;
    if (name === 'IDAT') idat = true;
    at += 12 + len;
    if (name === 'IEND') return idat && len === 0 && at === b.length;
  }
  return false;
}

// JPEG: SOI, marker segments with their lengths, a frame header (SOF), entropy-coded scan data,
// and EOI at the end. After EOI only an embedded video (a "motion photo", which starts with an ISO
// BMFF ftyp box) may follow.
function isJpeg(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let at = 2;
  let sof = false;
  let sos = false;
  while (at < b.length) {
    if (b[at] !== 0xff) return false;
    while (b[at] === 0xff) at++;
    const m = b[at++];
    if (m === undefined) return false;
    if (m === 0xd9) {
      const rest = b.subarray(at);
      return sof && sos && (rest.length === 0 || (rest.length >= 16 && ascii(rest, 4, 'ftyp')));
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) continue;
    if (at + 2 > b.length) return false;
    const len = b.readUInt16BE(at);
    if (len < 2 || at + len > b.length) return false;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) sof = true;
    at += len;
    if (m === 0xda) {
      sos = true;
      // Entropy-coded data: runs until a marker other than a stuffed 0x00 or a restart marker.
      while (at < b.length - 1 && !(b[at] === 0xff && b[at + 1] !== 0x00 && !(b[at + 1] >= 0xd0 && b[at + 1] <= 0xd7))) at++;
      if (at >= b.length - 1) return false;
    }
  }
  return false;
}

// Ogg: pages to the very end, each "OggS" version 0 with a valid page CRC.
function isOgg(b: Buffer): boolean {
  let at = 0;
  let pages = 0;
  while (at < b.length) {
    if (at + 27 > b.length || !ascii(b, at, 'OggS') || b[at + 4] !== 0) return false;
    const segments = b[at + 26];
    if (at + 27 + segments > b.length) return false;
    let len = 27 + segments;
    for (let i = 0; i < segments; i++) len += b[at + 27 + i];
    if (at + len > b.length) return false;
    const page = Buffer.from(b.subarray(at, at + len));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    if (oggCrc(page) !== crc) return false;
    at += len;
    pages++;
  }
  return pages > 0;
}

// RIFF sub-chunks after the form type, chained to the end (odd sizes padded), with the chunks the
// form needs.
function riffChunks(b: Buffer, needs: string[]): boolean {
  const seen = new Set<string>();
  let at = 12;
  while (at < b.length) {
    if (at + 8 > b.length || !printable4(b, at)) return false;
    const len = b.readUInt32LE(at + 4);
    if (len > b.length - at - 8) return false;
    seen.add(b.subarray(at, at + 4).toString('latin1'));
    at += 8 + len + (len & 1);
    if (at > b.length) return false;
  }
  return needs.every((n) => seen.has(n));
}

// Every accepted format's header holds binary bytes (lengths, flags, a 0x89/0xFF/0x1A marker), so
// a file whose start is plain text is refused whatever it begins with.
const looksBinary = (b: Buffer) => b.subarray(0, 64).some((x) => x < 0x09 || x >= 0x80);

/** Content check on the whole file; the extension only picks which check applies. */
export function looksLike(ext: string, file: Buffer): boolean {
  if (!looksBinary(file)) return false;
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return isJpeg(file);
    case '.png':
      return isPng(file);
    case '.webp':
      return riff(file, 'WEBP') && ['VP8 ', 'VP8L', 'VP8X'].includes(file.subarray(12, 16).toString('latin1')) && riffChunks(file, []);
    case '.avif':
      return isoBmff(file, ['meta']);
    case '.mp4':
    case '.m4a':
    case '.mov':
      return isoBmff(file, ['moov']);
    case '.wav':
      return riff(file, 'WAVE') && riffChunks(file, ['fmt ', 'data']);
    case '.avi':
      return riff(file, 'AVI ') && riffChunks(file, ['LIST']);
    case '.mp3':
      return mp3(file);
    case '.aac':
      return mpegFramesToEnd(file, 0, adtsFrameLength);
    case '.ogg':
      return isOgg(file);
    case '.webm':
      // EBML magic, then the DocType element (0x42 0x82) naming webm inside the header.
      return file.length >= 16 && file.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && file.subarray(4, 64).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
    case '.mpg':
    case '.mpeg':
      return file[0] === 0x00 && file[1] === 0x00 && file[2] === 0x01 && (file[3] === 0xba || file[3] === 0xb3);
    default:
      return false;
  }
}

export class UploadRejected extends Error {}

const SYSTEM_DIRS = ['/proc', '/sys', '/dev', '/etc', '/boot', '/run', '/var/run', '/private/etc', '/private/var/run'];

const within = (dir: string, file: string) => {
  const rel = relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** AIVEED_MCP_UPLOAD_DIRS: comma-separated directories uploads must come from (~ is the home folder). */
export function uploadDirs(raw = process.env.AIVEED_MCP_UPLOAD_DIRS): string[] {
  return (raw || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (d === '~' ? homedir() : d.startsWith('~/') ? join(homedir(), d.slice(2)) : d))
    // A relative entry would depend on the client's working directory: ignored, and so allows nothing.
    .filter((d) => isAbsolute(d));
}

/** Network (\\server\share, //server/share) and device (\\?\, \\.\) paths: never touched. */
const isNetworkOrDevicePath = (p: string) => /^[\\/]{2}/.test(p);

export const NOT_ALLOWED =
  'File not found, or not in a folder allowed for upload (AIVEED_MCP_UPLOAD_DIRS; hidden and system folders are never allowed)';
export const UPLOADS_OFF =
  'upload_media is off until the user lists the folders it may read in AIVEED_MCP_UPLOAD_DIRS (comma-separated, e.g. ~/Videos,~/Pictures) in the MCP server config. Ask the user to set it, or use a public URL instead.';

const hiddenOrSystem = (p: string) =>
  p.split(/[\\/]/).some((part) => part.startsWith('.') && part.length > 1) || SYSTEM_DIRS.some((dir) => within(dir, p));

/** Path rules on the resolved path: the resolved allowed folder it is in, or null. */
async function allowedRoot(real: string, allowedDirs: string[]): Promise<string | null> {
  if (isNetworkOrDevicePath(real) || hiddenOrSystem(real)) return null;
  const roots = await Promise.all(allowedDirs.map((d) => realpath(d).catch(() => null)));
  return roots.find((root) => root !== null && !isNetworkOrDevicePath(root) && !hiddenOrSystem(root) && within(root, real)) ?? null;
}

/** True if any existing component of `path` is a symlink (or, on Windows, a junction). */
async function hasLinkComponent(path: string): Promise<boolean> {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  let cur = /^[\\/]/.test(path) ? sep : '';
  for (const part of parts) {
    cur = cur ? join(cur, part) : part.endsWith(':') ? part + sep : part;
    const st = await lstat(cur).catch(() => null);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * After the file is open: it must still sit at `real`, reached from the allowed folder through
 * real directories only, and be the very file the descriptor holds (same device and inode). A
 * parent swapped for a symlink while the file was opened, then swapped back, fails here because
 * the descriptor then holds some other file. Works on every platform, unlike /proc/self/fd.
 */
async function stillAt(root: string, real: string, opened: { dev: number; ino: number }): Promise<boolean> {
  let cur = root;
  const parts = relative(root, real).split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const st = await lstat(cur).catch(() => null);
    if (!st || st.isSymbolicLink()) return false;
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile() || st.dev !== opened.dev || st.ino !== opened.ino) return false;
  }
  return parts.length > 0;
}

/** Checks the file and builds the multipart body. Throws UploadRejected with a reason. */
export async function prepareUpload(path: string, kind: UploadKind, allowedDirs = uploadDirs()): Promise<FormData> {
  if (allowedDirs.length === 0) throw new UploadRejected(UPLOADS_OFF);
  // Before any filesystem call: on Windows even resolving a UNC path contacts the server. The
  // lexical checks also run first, so a refused path is never touched.
  if (isNetworkOrDevicePath(path)) throw new UploadRejected('Network and device paths cannot be uploaded');
  if (!isAbsolute(path)) throw new UploadRejected('Give the absolute path of the file');
  if (hiddenOrSystem(path)) throw new UploadRejected(NOT_ALLOWED);
  // The extension is checked on the name given, before the filesystem is touched, so the answer
  // for "photo.txt" does not depend on whether it exists.
  if (!TYPES[kind][extname(path).toLowerCase()]) throw new UploadRejected(`A ${kind} upload must be one of: ${Object.keys(TYPES[kind]).join(', ')}`);
  // Windows: a symlink or junction on the way could lead to a network share, and resolving it would
  // already contact that server. Such paths are refused before anything is resolved.
  if (process.platform === 'win32' && (await hasLinkComponent(path))) throw new UploadRejected(NOT_ALLOWED);
  const real = await realpath(path).catch(() => null);
  if (real === null) throw new UploadRejected(NOT_ALLOWED);
  const root = await allowedRoot(real, allowedDirs);
  const ext = extname(real).toLowerCase();
  const type = TYPES[kind][ext];
  if (root === null || !type) throw new UploadRejected(NOT_ALLOWED);

  // O_NOFOLLOW: the last component must not have become a symlink since realpath. O_NONBLOCK: a
  // FIFO swapped in cannot block the open. Everything after this reads the descriptor.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fh = await open(real, flags).catch(() => {
    throw new UploadRejected('File could not be opened');
  });
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new UploadRejected('Only regular files can be uploaded');
    if (info.nlink > 1) throw new UploadRejected('Files with more than one hard link cannot be uploaded');
    // The descriptor must be the file that was checked (and, on Linux, its own path must agree).
    const opened = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
    if ((opened !== null && opened !== real) || !(await stillAt(root, real, info))) {
      throw new UploadRejected('File changed while it was being checked');
    }
    if (info.size === 0) throw new UploadRejected('File is empty');
    if (info.size > SIZE_CAPS[kind]) throw new UploadRejected(`${kind} files must be under ${SIZE_CAPS[kind] / (1024 * 1024)} MB`);

    // Read at most size + 1 bytes, so a file that grows after the stat cannot exhaust memory.
    const buf = Buffer.alloc(info.size + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > info.size) throw new UploadRejected('File changed while it was being read');
    }
    if (n !== info.size) throw new UploadRejected('File changed while it was being read');
    const bytes = buf.subarray(0, n);
    if (!looksLike(ext, bytes)) throw new UploadRejected(`File content is not a valid ${ext} ${kind}`);
    const form = new FormData();
    form.set('kind', kind);
    form.set('file', new Blob([new Uint8Array(bytes)], { type }), basename(real));
    return form;
  } finally {
    await fh.close();
  }
}
