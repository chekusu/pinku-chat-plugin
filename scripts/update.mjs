/**
 * Self-update for packages the agent unpacked itself (Grok, OpenClaw, Hermes and other skill hosts).
 * Hosts that manage plugin copies themselves (Claude Code, Codex, Gemini CLI) update through
 * their own commands instead. The private config lives outside the package and is never touched.
 */

import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, crc32 } from 'node:zlib';
import { PinkchatClientError } from './client.mjs';
import { updateCheck } from './enrollment.mjs';
import { CLIENT_VERSION, RELEASE_KEYS, packageInfo, releaseMessage } from './version.mjs';

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const fail = (code) => { throw new PinkchatClientError(code, 0, code); };

const HOST_MANAGED = [
  [`${sep}.claude${sep}plugins${sep}`, 'Claude Code manages this copy: run /plugin marketplace update pinkchat, or turn on auto-update for the pinkchat marketplace in /plugin.'],
  [`${sep}.codex${sep}`, 'Codex manages this copy: download the new package, run its scripts/install-client-plugin.py, then start a new session.'],
  [`${sep}.gemini${sep}extensions${sep}`, 'Gemini CLI manages this copy: run gemini extensions update pinkchat.'],
];

/** Reads the archives our build writes: one top-level directory, stored or deflated regular files. */
export function readZip(bytes) {
  const buffer = Buffer.from(bytes);
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) fail('update_archive_invalid');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = [];
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) fail('update_archive_invalid');
    const method = buffer.readUInt16LE(offset + 10), crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const mode = buffer.readUInt32LE(offset + 38) >>> 16, local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => part === '..' || part === '')) fail('update_archive_unsafe_path');
    if ((mode & 0o170000) !== 0 && (mode & 0o170000) !== 0o100000) fail('update_archive_unsafe_entry');
    if (size > MAX_ENTRY_BYTES || ![0, 8].includes(method)) fail('update_archive_unsupported');
    if (buffer.readUInt32LE(local) !== 0x04034b50) fail('update_archive_invalid');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    if (data.length !== size || crc32(data) !== crc) fail('update_archive_corrupt');
    files.push({ name, data, executable: (mode & 0o111) !== 0 });
  }
  const tops = new Set(files.map((file) => file.name.split('/')[0]));
  if (tops.size !== 1 || files.some((file) => !file.name.includes('/'))) fail('update_archive_layout');
  return { top: [...tops][0], files };
}

/** True only when the signature is by a key this package trusts and covers exactly this archive. */
export function verifyReleaseSignature(release, signature, keys = RELEASE_KEYS) {
  const key = typeof signature?.keyId === 'string' && Object.hasOwn(keys, signature.keyId) ? keys[signature.keyId] : undefined;
  if (!key || typeof signature.value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature.value)) return false;
  try {
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
    return verify(null, Buffer.from(releaseMessage(release)), publicKey, Buffer.from(signature.value, 'base64url'));
  } catch { return false; }
}

export async function selfUpdate(configPath, { baseUrl, confirm } = {}) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const managed = HOST_MANAGED.find(([marker]) => `${root}${sep}`.includes(marker));
  if (managed) return { status: 'host_managed', current: CLIENT_VERSION, next: managed[1] };
  const { package: kind } = await packageInfo();
  if (!kind) fail('update_package_unknown');
  const check = await updateCheck(configPath, { baseUrl, package: kind });
  if (check.status === 'current') return check;
  if (confirm !== true) return { ...check, next: 'Ask the owner first. After they agree, run self-update again with --confirm (MCP: confirm true).' };
  const download = check.download;
  if (!download?.url || !/^[a-f0-9]{64}$/.test(download.sha256 ?? '')) fail('update_manifest_invalid');
  // A release key, not only the HTTPS origin, must vouch for the archive before anything is downloaded.
  if (Object.keys(RELEASE_KEYS).length) {
    if (!download.signature) fail('update_signature_missing');
    if (!verifyReleaseSignature({ package: kind, version: check.latest, file: download.file, sha256: download.sha256 }, download.signature)) fail('update_signature_invalid');
  }
  // Only the origin this installation already talks to may supply its code.
  let source;
  try { source = new URL(download.url); } catch { fail('update_manifest_invalid'); }
  if (source.origin !== check.origin || (source.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(source.hostname))) fail('update_origin_mismatch');
  let response;
  try { response = await fetch(download.url, { redirect: 'error', signal: AbortSignal.timeout(60000) }); } catch { fail('update_download_failed'); }
  if (!response.ok) fail(`update_download_http_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) fail('update_archive_too_large');
  if (createHash('sha256').update(bytes).digest('hex') !== download.sha256) fail('update_checksum_mismatch');
  const { top, files } = readZip(bytes);
  const staging = `${root}.update-${randomUUID()}`;
  try {
    for (const file of files) {
      const target = join(staging, file.name);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, file.data, { mode: file.executable ? 0o755 : 0o644, flag: 'wx' });
    }
    const fresh = join(staging, top);
    const marker = JSON.parse(await readFile(join(fresh, 'pinkchat-package.json'), 'utf8'));
    const version = /CLIENT_VERSION = '([0-9.]+)'/.exec(await readFile(join(fresh, 'scripts/version.mjs'), 'utf8'))?.[1];
    if (marker.package !== kind || version !== check.latest) fail('update_package_mismatch');
    await stat(join(fresh, 'scripts/cli.mjs'));
    let previous = `${root}.previous-${CLIENT_VERSION}`;
    try { await stat(previous); previous = `${previous}-${Date.now()}`; } catch { /* free name */ }
    await rename(root, previous);
    try { await rename(fresh, root); } catch (error) { await rename(previous, root); throw error; }
    return {
      status: 'updated', from: CLIENT_VERSION, to: version, package: kind, path: root, previous,
      next: 'The new package is in place. Start a new agent session (or reload skills) so the host loads it, then run health once. The old copy is kept beside it until the owner removes it.',
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
