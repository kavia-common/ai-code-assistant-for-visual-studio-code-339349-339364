'use strict';

/**
 * Thin Node backend REST client for the webview UI.
 *
 * This file is intentionally framework-agnostic and contains the single canonical
 * code path for calling the node_backend container, to avoid duplicated fetch logic.
 *
 * Contract:
 * - Inputs: baseUrl (string), fetchImpl (optional), and method-specific params.
 * - Outputs: parsed JSON responses for 2xx; throws Error for non-2xx with details.
 * - Errors: throws Error with `status` and `payload` attached when available.
 * - Side effects: network I/O only.
 */

function _joinUrl(baseUrl, path) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return `${b}/${p}`;
}

async function _readJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function _requestJson(fetchImpl, url, { method, body, headers } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await _readJsonSafe(res);

  if (!res.ok) {
    const err = new Error(`Request failed: ${method} ${url} -> ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

/**
 * Create a client instance.
 *
 * IMPORTANT:
 * - In VS Code webview, the extension host should proxy requests; this client is
 *   for direct browser/dev and smoke-flow validation against node_backend.
 */
// PUBLIC_INTERFACE
function createNodeBackendClient({
  baseUrl = process.env.REACT_APP_NODE_BACKEND_URL || 'http://localhost:3001',
  fetchImpl = fetch,
} = {}) {
  /** PUBLIC_INTERFACE */
  return {
    baseUrl,

    // Settings
    getSettings: () =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, '/api/settings'), { method: 'GET' }),

    getSetting: (key) =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, `/api/settings/${encodeURIComponent(key)}`), {
        method: 'GET',
      }),

    putSetting: (key, value) =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, `/api/settings/${encodeURIComponent(key)}`), {
        method: 'PUT',
        body: { value },
      }),

    // Telemetry
    getTelemetryPreference: () =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, '/api/telemetry/preference'), { method: 'GET' }),

    setTelemetryPreference: (isOptedIn) =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, '/api/telemetry/preference'), {
        method: 'PUT',
        body: { isOptedIn },
      }),

    // Chat sessions/messages
    createSession: ({ title = null, providerConfigId = null } = {}) =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, '/api/chat/sessions'), {
        method: 'POST',
        body: { title, providerConfigId },
      }),

    listSessions: ({ limit = 50, offset = 0 } = {}) =>
      _requestJson(
        fetchImpl,
        _joinUrl(baseUrl, `/api/chat/sessions?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`),
        { method: 'GET' }
      ),

    getSession: (sessionId) =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'GET',
      }),

    listMessages: ({ sessionId, limit = 200, offset = 0 }) =>
      _requestJson(
        fetchImpl,
        _joinUrl(
          baseUrl,
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(
            offset
          )}`
        ),
        { method: 'GET' }
      ),

    sendMessage: ({ sessionId, content, providerConfigId = null, apiKey = null }) =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`), {
        method: 'POST',
        body: { content, providerConfigId, apiKey },
      }),

    // Confirmations
    getConfirmation: (confirmationId) =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, `/api/confirmations/${encodeURIComponent(confirmationId)}`), {
        method: 'GET',
      }),

    decideConfirmation: ({ confirmationId, decision }) =>
      _requestJson(fetchImpl, _joinUrl(baseUrl, `/api/confirmations/${encodeURIComponent(confirmationId)}`), {
        method: 'POST',
        body: { decision },
      }),
  };
}

module.exports = {
  createNodeBackendClient,
};
