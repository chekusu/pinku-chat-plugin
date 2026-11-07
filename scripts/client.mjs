#!/usr/bin/env node
/**
 * Small, dependency-free client for the authenticated Pinku.chat client API.
 *
 * This file is shared by the Codex and Grok Bot packages.  It intentionally
 * has no mutable actor/session singleton: every exported operation receives a
 * profile and the account id is sent with that request.  Tokens are read from
 * a mode-0600 file outside the plugin tree and are never included in errors.
 */

import { readFile, writeFile, mkdir, stat, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CLIENT_VERSION, rememberServerVersions, rememberInbox, rememberProfile } from './version.mjs';

const DEFAULT_CONFIG = '~/.config/pinkchat/client.json';
const MAX_ERROR_TEXT = 240;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function expandHome(path) {
  if (path === '~') return process.env.HOME || path;
  if (path.startsWith('~/')) return resolve(process.env.HOME || '.', path.slice(2));
  return resolve(path);
}

export function defaultConfigPath() {
  return expandHome(process.env.PINKCHAT_CLIENT_CONFIG || DEFAULT_CONFIG);
}

function safeErrorText(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, MAX_ERROR_TEXT);
}

export class PinkchatClientError extends Error {
  constructor(message, status = 0, code = 'client_error', details = undefined) {
    super(message);
    this.name = 'PinkchatClientError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PinkchatClientError(`${label} is required`, 0, `invalid_${label}`);
  }
  return value.trim();
}

function tokenValue(value) {
  const token = requiredString(value, 'token');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new PinkchatClientError('token has an invalid credential format', 0, 'config_invalid');
  return token;
}

export function validateBaseUrl(value) {
  const text = requiredString(value, 'baseUrl').replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(text); } catch { throw new PinkchatClientError('baseUrl must be an absolute URL', 0, 'invalid_baseUrl'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new PinkchatClientError('baseUrl must use http or https', 0, 'invalid_baseUrl');
  if (parsed.username || parsed.password) throw new PinkchatClientError('baseUrl must not contain credentials', 0, 'invalid_baseUrl');
  if (parsed.search || parsed.hash) throw new PinkchatClientError('baseUrl must not contain a query or fragment', 0, 'invalid_baseUrl');
  const parts = parsed.hostname.split('.').map(Number);
  const tailnet = parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127 && parts.slice(2).every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && !tailnet) {
    throw new PinkchatClientError('non-local baseUrl requires HTTPS; plain HTTP is only allowed over the explicitly selected Tailscale network', 0, 'invalid_baseUrl');
  }
  return text;
}

function assertProfile(profile, config) {
  if (!profile || typeof profile !== 'object') throw new PinkchatClientError('profile is required for every request', 0, 'profile_required');
  const accountId = requiredString(profile.accountId, 'profile.accountId');
  if (accountId !== config.accountId) throw new PinkchatClientError('profile.accountId does not match this credential', 403, 'profile_mismatch');
  return { ...profile, accountId };
}

function checkAttachmentRef(ref) {
  if (!ref || typeof ref !== 'object') throw new PinkchatClientError('attachment must be an object', 0, 'invalid_attachment');
  const id = requiredString(ref.id, 'attachment.id');
  const variant = ref.variant === undefined ? 'original' : ref.variant;
  if (!['original', 'preview'].includes(variant)) throw new PinkchatClientError('attachment.variant must be original or preview', 0, 'invalid_attachment');
  return { id, variant };
}

export async function loadConfig(configPath = defaultConfigPath()) {
  const path = expandHome(configPath);
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new PinkchatClientError('cannot read client config as JSON; check the private file path and syntax', 0, 'config_unreadable'); }
  if (!parsed || typeof parsed !== 'object') throw new PinkchatClientError('client config must be a JSON object', 0, 'config_invalid');
  const config = {
    baseUrl: validateBaseUrl(parsed.baseUrl),
    token: tokenValue(parsed.token),
    installationId: requiredString(parsed.installationId, 'installationId'),
    accountId: requiredString(parsed.accountId, 'accountId'),
  };
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(config.installationId)) throw new PinkchatClientError('installationId contains unsupported characters', 0, 'config_invalid');
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(config.accountId)) throw new PinkchatClientError('accountId contains unsupported characters', 0, 'config_invalid');
  return { ...config, path };
}

export async function saveConfig(config, configPath = defaultConfigPath()) {
  const path = expandHome(configPath);
  const normalized = {
    baseUrl: validateBaseUrl(config.baseUrl),
    token: tokenValue(config.token),
    installationId: requiredString(config.installationId, 'installationId'),
    accountId: requiredString(config.accountId, 'accountId'),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return { ...normalized, path };
}

export async function ensureConfigMode(configPath) {
  const path = expandHome(configPath);
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new PinkchatClientError('client config must be readable only by its owner (mode 0600)', 0, 'config_permissions');
  return path;
}

export function makeClient(config) {
  const normalized = {
    baseUrl: validateBaseUrl(config.baseUrl),
    token: tokenValue(config.token),
    installationId: requiredString(config.installationId, 'installationId'),
    accountId: requiredString(config.accountId, 'accountId'),
  };

  async function request(profile, method, pathname, body, options = {}) {
    assertProfile(profile, normalized);
    const url = new URL(pathname.replace(/^\//, ''), `${normalized.baseUrl}/`);
    const headers = {
      accept: options.binary ? '*/*' : 'application/json',
      authorization: `Bearer ${normalized.token}`,
      'x-pinkchat-installation': normalized.installationId,
      'x-pinkchat-account-id': normalized.accountId,
      'x-pinkchat-client-version': CLIENT_VERSION,
    };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response;
    const timeout = AbortSignal.timeout(Math.max(100, Math.min(Number(options.requestTimeoutMs ?? 15000), 30000)));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try { response = await fetch(url, { method, headers, body: payload, signal, redirect: 'error' }); }
    catch (error) { throw new PinkchatClientError(`request failed: ${safeErrorText(error.message)}`, 0, 'network_error'); }
    rememberServerVersions(response.headers);
    rememberInbox(response.headers);
    rememberProfile(response.headers);
    if (response.status === 426) throw new PinkchatClientError('this Pinku.chat package is older than the server allows; update it from the install page', 426, 'client_upgrade_required');
    if (!response.ok) {
      let detail = '';
      try { detail = safeErrorText(await response.text()); } catch { /* keep the status only */ }
      const suffix = detail ? `: ${detail}` : '';
      throw new PinkchatClientError(`Pinku.chat API ${response.status}${suffix}`, response.status, 'api_error');
    }
    if (options.binary) return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'application/octet-stream' };
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new PinkchatClientError('Pinku.chat API returned invalid JSON', response.status, 'invalid_response'); }
  }

  const client = {
    config: { baseUrl: normalized.baseUrl, installationId: normalized.installationId, accountId: normalized.accountId },
    profile(profile) { return assertProfile(profile, normalized); },
    getProfile(profile, options) { return request(profile, 'GET', '/client/v1/profile', undefined, options); },
    importProfile(profile, input, options) { return request(profile, 'POST', '/client/v1/profile/import', input, options); },
    sharing(profile, input, options) { return request(profile, 'POST', '/client/v1/profile/sharing', input, options); },
    capabilities(profile, input, options) { return request(profile, input ? 'POST' : 'GET', '/client/v1/capabilities', input, options); },
    importAvailability(profile, input, options) { return request(profile, 'POST', '/client/v1/availability/import', input, options); },
    availability(profile, options) { return request(profile, 'GET', '/client/v1/availability', undefined, options); },
    discovery(profile, options) {
      const radiusKm = options?.radiusKm;
      if (radiusKm !== undefined && (typeof radiusKm !== 'number' || !Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 50)) {
        throw new PinkchatClientError('radiusKm must be a positive number at most 50', 400, 'invalid_radius');
      }
      const offset = options?.offset;
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0 || offset > 200)) {
        throw new PinkchatClientError('offset must be an integer from 0 to 200', 400, 'invalid_offset');
      }
      const query = [radiusKm === undefined ? '' : `radiusKm=${radiusKm}`, offset === undefined ? '' : `offset=${offset}`].filter(Boolean).join('&');
      return request(profile, 'GET', `/client/v1/discovery${query ? `?${query}` : ''}`, undefined, options);
    },
    health(profile, options) { return request(profile, 'GET', '/client/v1/health', undefined, options); },
    invite(profile, options) { return request(profile, 'GET', '/client/v1/invite', undefined, options); },
    rotateInvite(profile, options) { return request(profile, 'POST', '/client/v1/invite/rotate', {}, options); },
    linkCode(profile, options) { return request(profile, 'POST', '/client/v1/link-code', {}, options); },
    emails(profile, options) { return request(profile, 'GET', '/client/v1/email', undefined, options); },
    addEmail(profile, email, lang, options) { return request(profile, 'POST', '/client/v1/email', { email: requiredString(email, 'email'), ...(typeof lang === 'string' && lang.trim() ? { lang: lang.trim().slice(0, 64) } : {}) }, options); },
    verifyEmail(profile, code, options) { return request(profile, 'POST', '/client/v1/email/verify', { code: requiredString(code, 'code') }, options); },
    notifications(profile, input, options) {
      if (input === undefined) return request(profile, 'GET', '/client/v1/notifications', undefined, options);
      if (!input || typeof input.enabled !== 'boolean') throw new PinkchatClientError('enabled must be true or false', 0, 'invalid_notifications');
      return request(profile, 'POST', '/client/v1/notifications', { email: input.enabled ? { enabled: true, address: requiredString(input.address, 'address') } : { enabled: false } }, options);
    },
    requests(profile, options) { return request(profile, 'GET', '/client/v1/requests', undefined, options); },
    friends(profile, options) { return request(profile, 'GET', '/client/v1/friends', undefined, options); },
    friendsAttestation(profile, input, options) { return request(profile, 'POST', '/client/v1/friends/attestation', { email: requiredString(input?.email, 'email'), ownerCredentialSha256: requiredString(input?.ownerCredentialSha256, 'ownerCredentialSha256') }, options); },
    friendsLink(profile, input, options) { return request(profile, 'PUT', '/client/v1/friends/link', { gateway: requiredString(input?.gateway, 'gateway'), botId: requiredString(input?.botId, 'botId'), keyFingerprint: typeof input?.keyFingerprint === 'string' ? input.keyFingerprint : '' }, options); },
    requestContact(profile, input, options) {
      if (!input || typeof input !== 'object') throw new PinkchatClientError('request input is required', 0, 'invalid_request');
      if (!input.candidateId === !input.groupId) throw new PinkchatClientError('give exactly one of candidateId or groupId', 0, 'invalid_request');
      const note = typeof input.note === 'string' ? input.note.trim() : '';
      if (note.length > 300) throw new PinkchatClientError('note is at most 300 characters', 0, 'invalid_request');
      return request(profile, 'POST', '/client/v1/requests', {
        clientCommandId: requiredString(input.clientCommandId, 'clientCommandId'), kind: 'contact',
        ...(input.candidateId ? { candidateId: requiredString(input.candidateId, 'candidateId') } : { groupId: requiredString(input.groupId, 'groupId') }),
        ...(note ? { note } : {}),
      }, options);
    },
    requestPhoto(profile, input, options) {
      if (!input || typeof input !== 'object') throw new PinkchatClientError('request input is required', 0, 'invalid_request');
      if (!input.candidateId === !input.groupId) throw new PinkchatClientError('give exactly one of candidateId or groupId', 0, 'invalid_request');
      const note = typeof input.note === 'string' ? input.note.trim() : '';
      if (note.length > 300) throw new PinkchatClientError('note is at most 300 characters', 0, 'invalid_request');
      return request(profile, 'POST', '/client/v1/requests', {
        clientCommandId: requiredString(input.clientCommandId, 'clientCommandId'), kind: 'photo',
        ...(input.candidateId ? { candidateId: requiredString(input.candidateId, 'candidateId') } : { groupId: requiredString(input.groupId, 'groupId') }),
        ...(note ? { note } : {}),
      }, options);
    },
    decideRequest(profile, requestId, input, options) {
      if (!input || typeof input !== 'object') throw new PinkchatClientError('decision input is required', 0, 'invalid_decision');
      if (input.explicitConfirmation !== true) throw new PinkchatClientError('explicitConfirmation must be true: the owner decides, never the agent', 400, 'explicit_confirmation_required');
      if (!['approve', 'decline'].includes(input.decision)) throw new PinkchatClientError('decision must be approve or decline', 0, 'invalid_decision');
      // A photo is approved with the chosen photo, a contact exchange with a Friends follow permit (friends.mjs).
      if (input.decision === 'approve' && !input.attachmentId && !input.permit) throw new PinkchatClientError('approve needs the attachmentId of the photo the owner chose', 0, 'attachment_required');
      return request(profile, 'POST', `/client/v1/requests/${encodeURIComponent(requiredString(requestId, 'requestId'))}/decision`, {
        clientCommandId: requiredString(input.clientCommandId, 'clientCommandId'), decision: input.decision,
        ...(input.decision === 'approve' ? (input.permit ? { permit: requiredString(input.permit, 'permit') } : { attachmentId: requiredString(input.attachmentId, 'attachmentId') }) : {}),
        explicitConfirmation: true,
      }, options);
    },
    state(profile, conversationId, options) {
      return request(profile, 'GET', `/client/v1/state${conversationId ? `?conversationId=${encodeURIComponent(requiredString(conversationId, 'conversationId'))}` : ''}`, undefined, options);
    },
    session(profile, options) { return request(profile, 'GET', '/client/v1/session', undefined, options); },
    messages(profile, conversationId, options) {
      return request(profile, 'GET', `/client/v1/conversations/${encodeURIComponent(requiredString(conversationId, 'conversationId'))}/messages`, undefined, options);
    },
    sendMessage(profile, input, options) {
      if (!input || typeof input !== 'object') throw new PinkchatClientError('message input is required', 0, 'invalid_message');
      const clientMessageId = requiredString(input.clientMessageId, 'clientMessageId');
      const conversationId = requiredString(input.conversationId, 'conversationId');
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim() && !Array.isArray(input.attachments)) throw new PinkchatClientError('text or attachments is required', 0, 'invalid_message');
      const attachments = input.attachments === undefined ? undefined : input.attachments.map(checkAttachmentRef);
      return request(profile, 'POST', '/client/v1/messages', { clientMessageId, conversationId, text, ...(attachments ? { attachments } : {}) }, options);
    },
    receipt(profile, clientMessageId, options) {
      return request(profile, 'GET', `/client/v1/receipts/${encodeURIComponent(requiredString(clientMessageId, 'clientMessageId'))}`, undefined, options);
    },
    retry(profile, clientMessageId, explicitRetry, options) {
      if (explicitRetry !== true) throw new PinkchatClientError('explicitRetry must be true after the user requests a retry of this failed message', 400, 'explicit_retry_required');
      return request(profile, 'POST', `/client/v1/receipts/${encodeURIComponent(requiredString(clientMessageId, 'clientMessageId'))}/retry`, { explicitRetry: true }, options);
    },
    group(profile, input, options) {
      if (!input || typeof input !== 'object') throw new PinkchatClientError('group input is required', 0, 'invalid_group');
      return request(profile, 'POST', '/client/v1/groups', {
        clientCommandId: requiredString(input.clientCommandId, 'clientCommandId'),
        candidateId: requiredString(input.candidateId, 'candidateId'),
      }, options);
    },
    confirmation(profile, input, options) {
      if (!input || typeof input !== 'object') throw new PinkchatClientError('confirmation input is required', 0, 'invalid_confirmation');
      const action = input.action;
      if (!['accept', 'decline', 'cancel'].includes(action)) throw new PinkchatClientError('action must be accept, decline, or cancel', 0, 'invalid_confirmation');
      return request(profile, 'POST', '/client/v1/confirmations', {
        conversationId: requiredString(input.conversationId, 'conversationId'),
        proposalId: requiredString(input.proposalId, 'proposalId'),
        version: input.version,
        action,
      }, options);
    },
    decision(profile, input, options) {
      if (!input || typeof input !== 'object') throw new PinkchatClientError('decision input is required', 0, 'invalid_decision');
      if (input.explicitConfirmation !== true) throw new PinkchatClientError('explicitConfirmation must be true', 400, 'explicit_confirmation_required');
      return request(profile, 'POST', '/client/v1/decisions', {
        clientCommandId: requiredString(input.clientCommandId, 'clientCommandId'),
        challengeId: requiredString(input.challengeId, 'challengeId'),
        explicitConfirmation: true,
      }, options);
    },
    upload(profile, input, options) {
      if (!input || typeof input !== 'object') throw new PinkchatClientError('attachment input is required', 0, 'invalid_attachment');
      const mimeType = requiredString(input.mimeType, 'mimeType').toLowerCase();
      if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) throw new PinkchatClientError('unsupported image mimeType', 400, 'invalid_attachment');
      const contentBase64 = requiredString(input.contentBase64, 'contentBase64');
      let bytes;
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 === 1) throw new PinkchatClientError('contentBase64 is invalid', 400, 'invalid_attachment');
      try { bytes = Buffer.from(contentBase64, 'base64'); } catch { throw new PinkchatClientError('contentBase64 is invalid', 400, 'invalid_attachment'); }
      if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new PinkchatClientError('attachment size is outside the allowed range', 400, 'invalid_attachment');
      return request(profile, 'POST', '/client/v1/attachments', { contentBase64, mimeType }, options);
    },
    attachment(profile, attachmentId, variant = 'preview', options) {
      const id = requiredString(attachmentId, 'attachmentId');
      if (!['original', 'preview'].includes(variant)) throw new PinkchatClientError('variant must be original or preview', 0, 'invalid_attachment');
      return request(profile, 'GET', `/client/v1/attachments/${encodeURIComponent(id)}?variant=${encodeURIComponent(variant)}${options?.forModel ? '&purpose=model' : ''}`, undefined, { ...options, binary: true });
    },
    deleteAttachment(profile, attachmentId, options) {
      return request(profile, 'DELETE', `/client/v1/attachments/${encodeURIComponent(requiredString(attachmentId, 'attachmentId'))}`, undefined, options);
    },
    async waitReceipt(profile, clientMessageId, options = {}) {
      const id = requiredString(clientMessageId, 'clientMessageId');
      const timeoutMs = Math.max(0, Math.min(Number(options.timeoutMs ?? 30000), 60000));
      if (!Number.isFinite(timeoutMs)) throw new PinkchatClientError('timeoutMs must be a finite number', 0, 'invalid_timeout');
      const pollMs = Math.max(50, Math.min(Number(options.pollMs ?? 250), 5000));
      const deadline = Date.now() + timeoutMs;
      let last;
      while (true) {
        last = await client.receipt(profile, id, { ...options, requestTimeoutMs: Math.max(100, Math.min(15000, deadline - Date.now())) });
        if (last && ['done', 'failed'].includes(last.status)) return last;
        if (Date.now() >= deadline) return { ...(last || {}), status: 'timeout', clientMessageId: id };
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      }
    },
    async sendAndWait(profile, input, options = {}) {
      const accepted = await client.sendMessage(profile, input, options);
      const id = input?.clientMessageId;
      if (typeof id !== 'string' || !id.trim()) throw new PinkchatClientError('clientMessageId is required before waiting for a result', 0, 'invalid_message');
      const receipt = await client.waitReceipt(profile, id, options);
      return { accepted, receipt };
    },
    newId(prefix = 'client') { return `${prefix}_${randomUUID()}`; },
  };
  return client;
}

export async function fromConfig(configPath = defaultConfigPath()) {
  const config = await loadConfig(configPath);
  await ensureConfigMode(config.path);
  // Direct messages keep their private data homes next to this file (friends.mjs).
  return Object.assign(makeClient(config), { configPath: config.path, clientKind: config.clientKind });
}

