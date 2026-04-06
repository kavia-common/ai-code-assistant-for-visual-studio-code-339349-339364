import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

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

// PUBLIC_INTERFACE
function App() {
  /**
   * Bridge to VS Code. All communication should go through this object.
   * In VS Code: it is the true webview API.
   * In browser: it is a stub (still functional for UI/dev/testing).
   */
  const vscode = useMemo(() => acquireVsCodeApiSafe(), []);

  const transcriptEndRef = useRef(null);
  const [leftWidth, setLeftWidth] = useState(320);

  // Settings state (persisted via vscode.setState / getState).
  const [providerId, setProviderId] = useState('openai');
  const [model, setModel] = useState('gpt-4o-mini');
  const [temperature, setTemperature] = useState(0.2);
  const [telemetryOptIn, setTelemetryOptIn] = useState(false);

  // Chat state
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
      // Keep logs bounded so the webview stays snappy
      return next.slice(-400);
    });
  }, []);

  // Hydrate persisted state (if any)
  useEffect(() => {
    const state = vscode.getState?.();
    if (!state) return;

    if (state.providerId) setProviderId(state.providerId);
    if (typeof state.model === 'string') setModel(state.model);
    if (typeof state.temperature === 'number') setTemperature(state.temperature);
    if (typeof state.telemetryOptIn === 'boolean') setTelemetryOptIn(state.telemetryOptIn);
    if (Array.isArray(state.messages)) setMessages(state.messages);

    addLog('Hydrated UI state from vscode.getState()');
  }, [addLog, vscode]);

  // Persist state changes
  useEffect(() => {
    vscode.setState?.({
      providerId,
      model,
      temperature,
      telemetryOptIn,
      messages,
    });
  }, [messages, model, providerId, telemetryOptIn, temperature, vscode]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // Handle incoming messages from extension/backend
  useEffect(() => {
    function onMessage(event) {
      const msg = event?.data;
      if (!msg || typeof msg !== 'object') return;

      // The extension should use postMessage({ type: '...', ... })
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
        // Allows backend/extension to push settings changes.
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

  const onSend = useCallback(() => {
    const text = composerText.trim();
    if (!text || isSending) return;

    const userMsg = { id: `u-${Date.now()}`, role: 'user', content: text, ts: nowIso() };
    setMessages((prev) => prev.concat([userMsg]));
    setComposerText('');
    setIsSending(true);

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

    // In browser stub mode we can simulate an assistant response for UX/testing.
    if (typeof window.acquireVsCodeApi !== 'function') {
      window.setTimeout(() => {
        window.postMessage(
          {
            type: 'assistantMessage',
            id: `stub-a-${Date.now()}`,
            content:
              `Stub reply (not running in VS Code):\n\nYou said: "${text}"\n\n` +
              `Provider: ${providerId}\nModel: ${model}\nTemp: ${temperature}`,
            ts: nowIso(),
          },
          '*'
        );
      }, 350);
    }
  }, [composerText, isSending, model, providerId, sendToExtension, telemetryOptIn, temperature]);

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

  const confirmAccept = useCallback(() => {
    if (!confirmState) return;

    const { requestId, payload } = confirmState;
    setConfirmState(null);

    // Local actions:
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

    // Default: respond to a backend confirmation request.
    sendToExtension({ type: 'confirmationResponse', requestId, accepted: true });
  }, [confirmState, sendToExtension]);

  const confirmCancel = useCallback(() => {
    if (!confirmState) return;
    const { requestId } = confirmState;
    setConfirmState(null);
    sendToExtension({ type: 'confirmationResponse', requestId, accepted: false });
  }, [confirmState, sendToExtension]);

  const beginResize = useCallback((e) => {
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
  }, [leftWidth]);

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
              onBlur={() => sendToExtension({ type: 'settingsChanged', key: 'model', value: model })}
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
              onMouseUp={() =>
                sendToExtension({ type: 'settingsChanged', key: 'temperature', value: temperature })
              }
            />
          </div>

          <div className="sidebarSection">
            <div className="sectionTitle">Privacy</div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={telemetryOptIn}
                onChange={(e) => {
                  const next = e.target.checked;
                  setTelemetryOptIn(next);
                  sendToExtension({ type: 'settingsChanged', key: 'telemetryOptIn', value: next });
                }}
              />
              <span>Opt into telemetry</span>
            </label>

            <div className="hint">
              Telemetry is optional. When enabled, only minimal usage metrics should be sent by the
              extension.
            </div>
          </div>

          <div className="sidebarFooter">
            <div className="mono small">
              Bridge: {typeof window.acquireVsCodeApi === 'function' ? 'VS Code' : 'Browser stub'}
            </div>
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
