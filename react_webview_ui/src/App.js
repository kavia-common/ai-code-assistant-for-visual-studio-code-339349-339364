import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { createNodeBackendClient } from './api/nodeBackendClient';

/**
 * Returns the VS Code webview API if available, otherwise returns a stub that
 * uses window.postMessage and local listeners (useful for running in a browser).
 */
function acquireVsCodeApiSafe() {
  // VS Code injects acquireVsCodeApi into the webview global scope.
  if (typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function') {
    return window.acquireVsCodeApi();
  }

  // Browser stub: keep "state" in-memory and send messages via window.postMessage.
  let _state = undefined;
  return {
    postMessage: (message) => {
      window.postMessage({ __vscodeStub: true, ...message }, '*');
    },
    setState: (newState) => {
      _state = newState;
    },
    getState: () => _state,
  };
}

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI-compatible' },
  { id: 'anthropic', name: 'Anthropic-compatible' },
  { id: 'local', name: 'Local model' },
];

function nowIso() {
  return new Date().toISOString();
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toUiMessage(m) {
  // Backend message shape: {id, sessionId, role, content, createdAtMs}
  // UI message shape: {id, role, content, ts}
  const ts = typeof m?.createdAtMs === 'number' ? new Date(m.createdAtMs).toISOString() : nowIso();
  return { id: m.id || `m-${Date.now()}`, role: m.role, content: String(m.content ?? ''), ts };
}

/**
 * Canonical browser smoke flow:
 * - Load settings from backend.
 * - Ensure a session exists (persisted).
 * - Load messages for that session.
 * This gives the “save settings → send chat → reload persisted history” E2E path.
 */
async function browserSmokeHydrate({ client, addLog }) {
  const result = {
    settings: null,
    telemetryPref: null,
    sessionId: null,
    messages: [],
  };

  addLog('SmokeHydrate: start');

  // Settings
  try {
    const settings = await client.getSettings();
    result.settings = settings;
    addLog(`SmokeHydrate: loaded settings (${(settings?.items || []).length} keys)`);
  } catch (e) {
    addLog(`SmokeHydrate: settings load failed (${e.status || 'no-status'}): ${String(e)}`);
  }

  // Telemetry preference
  try {
    const pref = await client.getTelemetryPreference();
    result.telemetryPref = pref;
    addLog(`SmokeHydrate: loaded telemetry preference (optedIn=${!!pref?.isOptedIn})`);
  } catch (e) {
    addLog(`SmokeHydrate: telemetry pref load failed (${e.status || 'no-status'}): ${String(e)}`);
  }

  // Ensure session exists
  const sessionKey = 'ui_active_session_id';
  let sessionId = null;
  try {
    const row = await client.getSetting(sessionKey);
    sessionId = row?.value || null;
  } catch (e) {
    addLog(`SmokeHydrate: getSetting(${sessionKey}) failed: ${String(e)}`);
  }

  if (!sessionId) {
    const created = await client.createSession({ title: 'Default session', providerConfigId: null });
    sessionId = created.id;
    await client.putSetting(sessionKey, sessionId);
    addLog(`SmokeHydrate: created session ${sessionId}`);
  } else {
    addLog(`SmokeHydrate: found existing session ${sessionId}`);
  }

  result.sessionId = sessionId;

  // Messages
  try {
    const msgResp = await client.listMessages({ sessionId, limit: 200, offset: 0 });
    const items = msgResp?.items || [];
    result.messages = items.map(toUiMessage);
    addLog(`SmokeHydrate: loaded ${items.length} messages`);
  } catch (e) {
    addLog(`SmokeHydrate: messages load failed: ${String(e)}`);
  }

  addLog('SmokeHydrate: end');
  return result;
}

// PUBLIC_INTERFACE
function App() {
  /**
   * Bridge to VS Code. All communication should go through this object.
   * In VS Code: it is the true webview API.
   * In browser: it is a stub (still functional for UI/dev/testing).
   */
  const vscode = useMemo(() => acquireVsCodeApiSafe(), []);
  const isInVsCodeWebview = typeof window.acquireVsCodeApi === 'function';

  const transcriptEndRef = useRef(null);
  const [leftWidth, setLeftWidth] = useState(320);

  // Settings state
  const [providerId, setProviderId] = useState('openai');
  const [model, setModel] = useState('gpt-4o-mini');
  const [temperature, setTemperature] = useState(0.2);
  const [telemetryOptIn, setTelemetryOptIn] = useState(false);

  // Chat state
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState(() => [
    {
      id: 'm1',
      role: 'assistant',
      content:
        'Hello! I am your AI coding assistant. Ask me to generate or edit code. ' +
        'This UI uses a VS Code-style postMessage bridge.',
      ts: nowIso(),
    },
  ]);
  const [composerText, setComposerText] = useState('');
  const [isSending, setIsSending] = useState(false);

  // Modals
  const [confirmState, setConfirmState] = useState(null); // { title, message, requestId, payload }
  const [isLogsOpen, setIsLogsOpen] = useState(false);

  // Debug logs (UI side)
  const [logs, setLogs] = useState(() => []);

  const addLog = useCallback((line) => {
    setLogs((prev) => {
      const next = prev.concat([{ id: `${Date.now()}-${Math.random()}`, ts: nowIso(), line }]);
      return next.slice(-400);
    });
  }, []);

  const backendClient = useMemo(() => {
    // Only used in browser mode. In VS Code mode, the extension should proxy calls.
    return createNodeBackendClient();
  }, []);

  // Hydrate persisted UI state (VS Code webview state) if any
  useEffect(() => {
    const state = vscode.getState?.();
    if (!state) return;

    if (state.providerId) setProviderId(state.providerId);
    if (typeof state.model === 'string') setModel(state.model);
    if (typeof state.temperature === 'number') setTemperature(state.temperature);
    if (typeof state.telemetryOptIn === 'boolean') setTelemetryOptIn(state.telemetryOptIn);
    if (Array.isArray(state.messages)) setMessages(state.messages);
    if (typeof state.activeSessionId === 'string') setActiveSessionId(state.activeSessionId);

    addLog('Hydrated UI state from vscode.getState()');
  }, [addLog, vscode]);

  // Persist UI state changes (webview only)
  useEffect(() => {
    vscode.setState?.({
      providerId,
      model,
      temperature,
      telemetryOptIn,
      messages,
      activeSessionId,
    });
  }, [activeSessionId, messages, model, providerId, telemetryOptIn, temperature, vscode]);

  // Browser smoke hydrate from backend for E2E contract validation
  useEffect(() => {
    if (isInVsCodeWebview) return;

    let isCancelled = false;
    (async () => {
      try {
        const hydrated = await browserSmokeHydrate({ client: backendClient, addLog });
        if (isCancelled) return;

        // Apply telemetry preference first (source of truth in browser mode)
        if (typeof hydrated?.telemetryPref?.isOptedIn === 'boolean') {
          setTelemetryOptIn(hydrated.telemetryPref.isOptedIn);
        }

        setActiveSessionId(hydrated.sessionId);

        // If backend already has history, show it; otherwise keep the welcome message.
        if (hydrated.messages && hydrated.messages.length > 0) {
          setMessages(hydrated.messages);
        } else {
          addLog('No persisted messages yet; showing welcome message.');
        }
      } catch (e) {
        addLog(`SmokeHydrate failed: ${String(e)}`);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [addLog, backendClient, isInVsCodeWebview]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // Handle incoming messages from extension/backend (VS Code webview mode)
  useEffect(() => {
    function onMessage(event) {
      const msg = event?.data;
      if (!msg || typeof msg !== 'object') return;

      const { type } = msg;

      if (type === 'assistantMessage') {
        addLog('Received assistantMessage');
        setMessages((prev) =>
          prev.concat([
            {
              id: msg.id || `a-${Date.now()}`,
              role: 'assistant',
              content: String(msg.content ?? ''),
              ts: msg.ts || nowIso(),
            },
          ])
        );
        setIsSending(false);
        return;
      }

      if (type === 'appendLog') {
        if (typeof msg.line === 'string') addLog(msg.line);
        return;
      }

      if (type === 'requestConfirmation') {
        addLog(`Received requestConfirmation (${msg.requestId || 'no-requestId'})`);
        setConfirmState({
          title: msg.title || 'Confirm action',
          message: msg.message || 'Do you want to proceed?',
          requestId: msg.requestId || `req-${Date.now()}`,
          payload: msg.payload ?? null,
        });
        return;
      }

      if (type === 'setSettings') {
        addLog('Received setSettings');
        if (msg.providerId) setProviderId(msg.providerId);
        if (typeof msg.model === 'string') setModel(msg.model);
        if (typeof msg.temperature === 'number') setTemperature(msg.temperature);
        if (typeof msg.telemetryOptIn === 'boolean') setTelemetryOptIn(msg.telemetryOptIn);
        return;
      }

      if (type === 'replaceTranscript' && Array.isArray(msg.messages)) {
        addLog('Received replaceTranscript');
        setMessages(msg.messages);
        setIsSending(false);
        return;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [addLog]);

  const sendToExtension = useCallback(
    (payload) => {
      try {
        vscode.postMessage(payload);
        addLog(`postMessage -> ${payload.type}`);
      } catch (e) {
        addLog(`postMessage failed: ${String(e)}`);
      }
    },
    [addLog, vscode]
  );

  const persistSettingBrowser = useCallback(
    async (key, value) => {
      // Only persists in browser mode; VS Code mode should be handled by extension.
      if (isInVsCodeWebview) return;
      try {
        await backendClient.putSetting(key, value);
        addLog(`Persisted setting to backend: ${key}`);
      } catch (e) {
        addLog(`Persist setting failed (${key}): ${String(e)}`);
      }
    },
    [addLog, backendClient, isInVsCodeWebview]
  );

  const onSend = useCallback(async () => {
    const text = composerText.trim();
    if (!text || isSending) return;

    const userMsg = { id: `u-${Date.now()}`, role: 'user', content: text, ts: nowIso() };
    setMessages((prev) => prev.concat([userMsg]));
    setComposerText('');
    setIsSending(true);

    // Always notify extension bridge (contract preserved).
    sendToExtension({
      type: 'chatUserMessage',
      message: userMsg,
      settings: {
        providerId,
        model,
        temperature,
        telemetryOptIn,
      },
    });

    // Browser mode: call node_backend REST API and persist history.
    if (!isInVsCodeWebview) {
      try {
        if (!activeSessionId) {
          // Defensive: hydrate should have created it, but keep flow non-patchy and robust.
          const created = await backendClient.createSession({ title: 'Default session', providerConfigId: null });
          setActiveSessionId(created.id);
          await backendClient.putSetting('ui_active_session_id', created.id);
          addLog(`Created session (late): ${created.id}`);
        }

        const sessionId = activeSessionId || (await backendClient.getSetting('ui_active_session_id'))?.value;
        if (!sessionId) throw new Error('No sessionId available for sending message');

        // Save UI settings into backend settings for smoke flow verification.
        await persistSettingBrowser('ui_providerId', providerId);
        await persistSettingBrowser('ui_model', model);
        await persistSettingBrowser('ui_temperature', temperature);
        await backendClient.setTelemetryPreference(telemetryOptIn);

        const result = await backendClient.sendMessage({
          sessionId,
          content: text,
          providerConfigId: null,
          apiKey: null,
        });

        const appended = result?.messagesAppended || [];
        const assistantAndTools = appended
          .filter((m) => m.role === 'assistant' || m.role === 'tool')
          .map(toUiMessage);

        if (assistantAndTools.length > 0) {
          setMessages((prev) => prev.concat(assistantAndTools));
        } else {
          // Should not happen; but keep UX stable.
          setMessages((prev) =>
            prev.concat([
              {
                id: `a-${Date.now()}`,
                role: 'assistant',
                content: 'No assistant response received.',
                ts: nowIso(),
              },
            ])
          );
        }

        setIsSending(false);
        return;
      } catch (e) {
        // Handle confirmation-required contract (backend uses AppError mapping).
        if (e && e.status === 409 && e.payload && e.payload.code === 'CONFIRMATION_REQUIRED') {
          const confirmationId = e.payload?.details?.confirmationId;
          addLog(`Backend requires confirmation: ${confirmationId || 'unknown'}`);
          setConfirmState({
            title: 'Confirmation required',
            message: `A sensitive operation requires approval before continuing.\n\nOperation: ${
              e.payload?.details?.operation || 'unknown'
            }\n\nOpen logs for details.`,
            requestId: confirmationId || `conf-${Date.now()}`,
            payload: { action: 'backendConfirmation', confirmationId },
          });
          // Leave isSending true until resolved (or cancel sets false).
          return;
        }

        addLog(`Backend send failed: ${String(e)} ${e?.payload ? JSON.stringify(e.payload) : ''}`);
        setIsSending(false);
        return;
      }
    }

    // VS Code webview: extension should respond with assistantMessage.
  }, [
    activeSessionId,
    addLog,
    backendClient,
    composerText,
    isInVsCodeWebview,
    isSending,
    model,
    persistSettingBrowser,
    providerId,
    sendToExtension,
    telemetryOptIn,
    temperature,
  ]);

  const onComposerKeyDown = useCallback(
    (e) => {
      // Send on Enter, allow newline with Shift+Enter
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend]
  );

  const onClearChat = useCallback(() => {
    setConfirmState({
      title: 'Clear chat transcript',
      message: 'This will remove all messages from the transcript. This cannot be undone.',
      requestId: `clear-${Date.now()}`,
      payload: { action: 'clearChat' },
    });
  }, []);

  const confirmAccept = useCallback(async () => {
    if (!confirmState) return;

    const { requestId, payload } = confirmState;
    setConfirmState(null);

    // Local UI action: clear transcript
    if (payload?.action === 'clearChat') {
      setMessages([
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: 'Transcript cleared. How can I help?',
          ts: nowIso(),
        },
      ]);
      setIsSending(false);
      sendToExtension({ type: 'uiAction', action: 'clearChatConfirmed' });
      return;
    }

    // Browser mode: resolve backend confirmation
    if (!isInVsCodeWebview && payload?.action === 'backendConfirmation' && payload?.confirmationId) {
      try {
        await backendClient.decideConfirmation({ confirmationId: payload.confirmationId, decision: 'approved' });
        addLog(`Confirmation approved: ${payload.confirmationId}`);

        // After approving, user can re-send; keep deterministic behavior by ending current send.
        setIsSending(false);
      } catch (e) {
        addLog(`Failed to approve confirmation: ${String(e)}`);
        setIsSending(false);
      }
      return;
    }

    // VS Code webview: respond to a backend confirmation request via extension
    sendToExtension({ type: 'confirmationResponse', requestId, accepted: true });
  }, [addLog, backendClient, confirmState, isInVsCodeWebview, sendToExtension]);

  const confirmCancel = useCallback(async () => {
    if (!confirmState) return;
    const { requestId, payload } = confirmState;
    setConfirmState(null);

    if (!isInVsCodeWebview && payload?.action === 'backendConfirmation' && payload?.confirmationId) {
      try {
        await backendClient.decideConfirmation({ confirmationId: payload.confirmationId, decision: 'rejected' });
        addLog(`Confirmation rejected: ${payload.confirmationId}`);
      } catch (e) {
        addLog(`Failed to reject confirmation: ${String(e)}`);
      } finally {
        setIsSending(false);
      }
      return;
    }

    setIsSending(false);
    sendToExtension({ type: 'confirmationResponse', requestId, accepted: false });
  }, [addLog, backendClient, confirmState, isInVsCodeWebview, sendToExtension]);

  const beginResize = useCallback(
    (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = leftWidth;

      function onMove(ev) {
        const delta = ev.clientX - startX;
        setLeftWidth(clamp(startWidth + delta, 240, 520));
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('is-resizing');
      }

      document.body.classList.add('is-resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [leftWidth]
  );

  const selectedProviderName = useMemo(() => {
    return PROVIDERS.find((p) => p.id === providerId)?.name || providerId;
  }, [providerId]);

  return (
    <div className="vscodeApp" data-testid="appRoot">
      <header className="topbar" role="banner">
        <div className="topbar__left">
          <div className="appTitle">AI Code Assistant</div>
          <div className="appSubtitle">Webview Panel</div>
        </div>

        <div className="topbar__right">
          <button className="btn btn--ghost" onClick={() => setIsLogsOpen(true)} type="button">
            Logs
          </button>
          <button className="btn btn--ghost" onClick={onClearChat} type="button">
            Clear
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar" style={{ width: `${leftWidth}px` }} aria-label="Settings sidebar">
          <div className="sidebarSection">
            <div className="sectionTitle">Provider</div>
            <label className="fieldLabel" htmlFor="providerSelect">
              Provider type
            </label>
            <select
              id="providerSelect"
              className="select"
              value={providerId}
              onChange={(e) => {
                const next = e.target.value;
                setProviderId(next);
                sendToExtension({ type: 'settingsChanged', key: 'providerId', value: next });
                persistSettingBrowser('ui_providerId', next);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            <div className="hint">
              Active: <strong>{selectedProviderName}</strong>
            </div>
          </div>

          <div className="sidebarSection">
            <div className="sectionTitle">Model</div>

            <label className="fieldLabel" htmlFor="modelInput">
              Model identifier
            </label>
            <input
              id="modelInput"
              className="input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => {
                sendToExtension({ type: 'settingsChanged', key: 'model', value: model });
                persistSettingBrowser('ui_model', model);
              }}
              placeholder="e.g. gpt-4.1-mini / claude-3.5-sonnet / llama3"
              spellCheck={false}
            />

            <label className="fieldLabel" htmlFor="tempRange">
              Temperature <span className="mono">({temperature.toFixed(2)})</span>
            </label>
            <input
              id="tempRange"
              className="range"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={temperature}
              onChange={(e) => {
                const next = Number(e.target.value);
                setTemperature(next);
              }}
              onMouseUp={() => {
                sendToExtension({ type: 'settingsChanged', key: 'temperature', value: temperature });
                persistSettingBrowser('ui_temperature', temperature);
              }}
            />
          </div>

          <div className="sidebarSection">
            <div className="sectionTitle">Privacy</div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={telemetryOptIn}
                onChange={async (e) => {
                  const next = e.target.checked;
                  setTelemetryOptIn(next);
                  sendToExtension({ type: 'settingsChanged', key: 'telemetryOptIn', value: next });

                  if (!isInVsCodeWebview) {
                    try {
                      await backendClient.setTelemetryPreference(next);
                      addLog(`Telemetry preference persisted (optedIn=${next})`);
                    } catch (err) {
                      addLog(`Telemetry preference persist failed: ${String(err)}`);
                    }
                  }
                }}
              />
              <span>Opt into telemetry</span>
            </label>

            <div className="hint">
              Telemetry is optional. When enabled, only minimal usage metrics should be sent by the extension.
            </div>
          </div>

          <div className="sidebarFooter">
            <div className="mono small">
              Bridge: {isInVsCodeWebview ? 'VS Code' : 'Browser + node_backend REST'}
            </div>
            {!isInVsCodeWebview && (
              <div className="mono small dim" style={{ marginTop: 6 }}>
                Session: {activeSessionId ? activeSessionId : 'loading…'}
              </div>
            )}
          </div>
        </aside>

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={beginResize}
        />

        <main className="main" aria-label="Chat panel">
          <section className="transcript" aria-label="Chat transcript">
            {messages.map((m) => (
              <div key={m.id} className={`msg msg--${m.role}`} data-testid={`msg-${m.role}`}>
                <div className="msg__meta">
                  <span className="msg__role">{m.role}</span>
                  <span className="msg__time">{formatTime(m.ts)}</span>
                </div>
                <pre className="msg__content">{m.content}</pre>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </section>

          <section className="composer" aria-label="Message composer">
            <textarea
              className="textarea"
              placeholder="Ask for code edits, generation, or explanations…"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              onKeyDown={onComposerKeyDown}
              disabled={isSending}
              rows={3}
              aria-label="Message input"
            />
            <div className="composerBar">
              <div className="composerHint">
                <span className="kbd">Enter</span> to send, <span className="kbd">Shift+Enter</span>{' '}
                for newline
              </div>
              <button
                className="btn btn--primary"
                onClick={onSend}
                type="button"
                disabled={isSending || !composerText.trim()}
              >
                {isSending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </section>
        </main>
      </div>

      {confirmState && (
        <Modal
          title={confirmState.title}
          onClose={confirmCancel}
          footer={
            <>
              <button className="btn btn--ghost" type="button" onClick={confirmCancel}>
                Cancel
              </button>
              <button className="btn btn--danger" type="button" onClick={confirmAccept}>
                Confirm
              </button>
            </>
          }
        >
          <p className="modalText">{confirmState.message}</p>
        </Modal>
      )}

      {isLogsOpen && (
        <Modal
          title="Logs"
          onClose={() => setIsLogsOpen(false)}
          footer={
            <>
              <button className="btn btn--ghost" type="button" onClick={() => setLogs([])}>
                Clear logs
              </button>
              <button className="btn btn--primary" type="button" onClick={() => setIsLogsOpen(false)}>
                Close
              </button>
            </>
          }
        >
          <div className="logs">
            {logs.length === 0 ? (
              <div className="hint">No logs yet.</div>
            ) : (
              logs.map((l) => (
                <div className="logLine" key={l.id}>
                  <span className="mono dim">{formatTime(l.ts)}</span> <span className="mono">{l.line}</span>
                </div>
              ))
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * Small accessible modal. Uses a backdrop and traps clicks (not a full focus trap).
 */
function Modal({ title, children, footer, onClose }) {
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose?.();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modalBackdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <div className="modalHeader">
          <div className="modalTitle">{title}</div>
          <button className="iconBtn" type="button" onClick={onClose} aria-label="Close modal">
            ✕
          </button>
        </div>
        <div className="modalBody">{children}</div>
        <div className="modalFooter">{footer}</div>
      </div>
    </div>
  );
}

export default App;
