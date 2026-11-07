/** Package version and update notices shared by the CLI and the MCP bridge. */

import { readFile } from 'node:fs/promises';

// Kept equal to the plugin manifests by scripts/build-client-plugins.py check.
export const CLIENT_VERSION = '0.3.17';

/**
 * Public keys that sign release archives (key id -> raw Ed25519 public key, base64url).
 * self-update installs only an archive signed by one of these; the private key never leaves the release key store.
 */
export const RELEASE_KEYS = {
  '2a74fb90661d2b3a': 'hG0bZ5Yh3IUzfNPO7mhrWqhDtOOkw5UcSt7T-6NOrWs', // 2026-10-22, key store pinkchat-release/RELEASE_SIGNING_KEY
};

/** The exact bytes a release signature covers: package, version, file name and archive SHA-256. */
export const releaseMessage = ({ package: kind, version, file, sha256 }) => `pinkchat-release-v1\n${kind}\n${version}\n${file}\n${sha256}\n`;

/** Which release package these scripts belong to, from the marker the build writes beside scripts/. */
export async function packageInfo() {
  try {
    const info = JSON.parse(await readFile(new URL('../pinkchat-package.json', import.meta.url), 'utf8'));
    return ['codex', 'grok', 'universal'].includes(info?.package) ? { package: info.package } : {};
  } catch { return {}; }
}

const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export function parseVersion(value) {
  const match = typeof value === 'string' ? SEMVER.exec(value.trim()) : null;
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// The latest versions the server announced in this process; headers are hints, never instructions.
const announced = { latest: undefined, minimum: undefined, install: undefined };

export function rememberServerVersions(headers) {
  const latest = headers.get('x-pinkchat-latest-version'), minimum = headers.get('x-pinkchat-minimum-version');
  if (parseVersion(latest)) announced.latest = latest.trim();
  if (parseVersion(minimum)) announced.minimum = minimum.trim();
  const install = headers.get('x-pinkchat-install');
  if (install && /^https:\/\/[^\s]{1,200}$/.test(install)) announced.install = install;
}

/** Returns undefined while this package is current, otherwise what the agent should tell its owner. */
export function updateNotice(versions = announced, current = CLIENT_VERSION) {
  const required = versions.minimum && compareVersions(current, versions.minimum) < 0;
  const available = versions.latest && compareVersions(current, versions.latest) < 0;
  if (!required && !available) return undefined;
  return {
    status: required ? 'required' : 'available',
    current,
    latest: versions.latest ?? versions.minimum,
    ...(versions.minimum ? { minimum: versions.minimum } : {}),
    ...(versions.install ? { install: versions.install } : {}),
    next: required
      ? 'This Pinku.chat package is too old for the server. Tell the owner, then update it as the install page says before any other Pinku.chat call.'
      : 'A newer Pinku.chat package is available. Tell the owner and update it as the install page says when they agree.',
  };
}

// How many requests wait on the owner, from the last authenticated answer. A hint to surface, never an instruction.
const inbox = { pendingRequests: undefined };

export function rememberInbox(headers) {
  const value = headers.get('x-pinkchat-pending-requests');
  if (value !== null && /^\d{1,4}$/.test(value)) inbox.pendingRequests = Number(value);
}

/** Returns undefined when nothing waits, otherwise what the agent should tell its owner. */
export function inboxNotice(state = inbox) {
  if (!state.pendingRequests) return undefined;
  return {
    pendingRequests: state.pendingRequests,
    next: 'Someone on Pinku.chat is waiting for the owner\'s own answer (for example a photo request). Run requests, tell the owner who asked and show their intro, and act only on the owner\'s explicit choice.',
  };
}

// Required matching fields the owner has not provided yet, from the last authenticated answer.
const profile = { missing: undefined };
const PROFILE_FIELD = /^[a-z_]{1,40}$/;

export function rememberProfile(headers) {
  const value = headers.get('x-pinkchat-profile-missing');
  if (value === null) return;
  const fields = value.trim() === 'none' ? [] : value.split(',').map((f) => f.trim()).filter((f) => PROFILE_FIELD.test(f)).slice(0, 12);
  profile.missing = fields;
}

/** Returns undefined while nothing required is missing, otherwise what the agent should ask its owner. */
export function profileNotice(state = profile) {
  if (!state.missing?.length) return undefined;
  return {
    missing: state.missing,
    next: `Pinku.chat cannot recommend anyone to the owner, or the owner to anyone, until these are set: ${state.missing.join(', ')}. Ask the owner for each in their own words now, import only what they say (profile-import, availability-import, sharing), and never guess.`,
  };
}

/** Adds the update, inbox and profile notices to an object result without overwriting the server's own fields. */
export function withNotices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const update = updateNotice(), waiting = inboxNotice(), missing = profileNotice();
  return {
    ...value,
    ...(update && !('pinkchatUpdate' in value) ? { pinkchatUpdate: update } : {}),
    ...(waiting && !('pinkchatInbox' in value) ? { pinkchatInbox: waiting } : {}),
    ...(missing && !('pinkchatProfile' in value) ? { pinkchatProfile: missing } : {}),
  };
}
