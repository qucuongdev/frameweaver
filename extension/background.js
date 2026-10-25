/**
 * FrameWeaver — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Mints reCAPTCHA and runs Flow's batchexecute RPCs inside the Flow tab.
 *
 * Flow moved to flow.google.com in September 2026 and stopped minting the
 * `Bearer ya29.…` the old REST host needed. The current path is `batch_rpc`:
 * the agent builds an `f.req` envelope, this worker mints a captcha for it and
 * runs the POST in the page's MAIN world, where the `at` CSRF token lives.
 * The bearer capture and the `api_request` / `trpc_request` proxies below are
 * the pre-migration path. The agent no longer sends either — it speaks only
 * `batch_rpc`. They stay so an extension updated ahead of its agent keeps
 * serving an older one; remove them once no agent in the wild sends them.
 */

const AGENT_WS_URL = 'ws://127.0.0.1:9222';

// labs.google/fx/tools/flow still resolves but redirects here, so in practice a
// signed-in tab is only ever flow.google.com/*. The legacy patterns stay for an
// old pinned tab. Every tab lookup in this file goes through this list.
const flowUrls = [
  'https://flow.google.com/*',
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];
const FLOW_TAB_URL = 'https://flow.google.com/';

let ws = null;
let flowKey = null;
let callbackSecret = null;  // Auth secret for HTTP callback, received from server on WS connect
let state = 'off'; // off | idle | running
let manualDisconnect = false;
let metrics = {
  tokenCapturedAt: null,
  requestCount: 0,   // captcha-consuming requests only (gen image/video/upscale)
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

// ─── URL → Log Type Classifier ─────────────────────────────

// Visible log types — only these appear in the request log
const _VISIBLE_TYPES = new Set(['GEN_IMG', 'GEN_VID', 'GEN_VID_REF', 'UPSCALE', 'TRACKING', 'URL_REFRESH']);

function _classifyApiUrl(url) {
  if (url.includes('uploadImage'))                     return 'UPLOAD';
  if (url.includes('batchGenerateImages'))              return 'GEN_IMG';
  if (url.includes('UpsampleVideo'))                   return 'UPSCALE';
  if (url.includes('ReferenceImages'))                 return 'GEN_VID_REF';
  if (url.includes('batchAsyncGenerateVideo'))          return 'GEN_VID';
  if (url.includes('batchCheckAsync'))                  return 'POLL';
  if (url.includes('upsampleImage'))                   return 'UPS_IMG';
  if (url.includes('/media/'))                         return 'MEDIA';
  if (url.includes('/credits'))                        return 'CREDITS';
  return 'API';
}

// ─── Request Log ────────────────────────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 100) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

// ─── Startup ────────────────────────────────────────────────

let initializationPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  void ensureInitialized();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureInitialized();
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ensureInitialized();
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
  if (alarm.name === 'token-refresh') {
    // Passive maintenance must never create browser tabs. If the user has no
    // Flow tab open, wait for an explicit action or an actual RPC to open one.
    await captureTokenFromFlowTab({ createIfMissing: false });
  }
});

function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = initialize().catch((error) => {
      initializationPromise = null;
      console.error('[FrameWeaver] Initialization failed', error);
      throw error;
    });
  }
  return initializationPromise;
}

async function initialize() {
  const data = await chrome.storage.local.get(['flowKey', 'metrics', 'callbackSecret']);
  if (data.flowKey) flowKey = data.flowKey;
  if (data.metrics) Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  connectToAgent();
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
}

// MV3 workers can be suspended and restarted without onStartup firing.
// Rehydrate the persisted Flow key on every worker start.
void ensureInitialized();

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Always update — even if same token string, refresh the timestamp
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });
    console.log('[FrameWeaver] Bearer token captured');

    // Notify agent
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);

// Capture real batchexecute headers for diagnosis
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const headers = (details.requestHeaders || []).map(h => `${h.name}: ${h.value}`);
      if (details.url.includes('StreamChat') || details.url.includes('batchexecute')) {
        const payload = {
          direction: 'headers_captured',
          url: details.url,
          headers,
          timestamp: Date.now()
        };
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'captured_flow', data: payload }));
        }
      }
    } catch (e) {}
  },
  { urls: ['https://flow.google.com/*', 'https://flow.google.com/_/*'] },
  ['requestHeaders', 'extraHeaders']
);

let _uiGenerateListener = null;

// Capture real batchexecute requests for diagnosis and UI generation interception
chrome.webRequest?.onBeforeRequest?.addListener(
  (details) => {
    try {
      if (details.method !== 'POST') return;
      const raw = details.requestBody?.raw;
      let bodyText = '';
      if (raw && raw.length > 0) {
        bodyText = new TextDecoder('utf-8').decode(new Uint8Array(raw[0].bytes));
      } else if (details.requestBody?.formData) {
        bodyText = JSON.stringify(details.requestBody.formData);
      }
      if (bodyText && bodyText.includes('f.req')) {
        const payload = {
          direction: 'request_webrequest',
          url: details.url,
          body: bodyText,
          timestamp: Date.now()
        };
        metrics.capturedFlow = payload;
        chrome.storage.local.set({ metrics });
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'captured_flow', data: payload }));
        }

        if (_uiGenerateListener) {
          // Do NOT match as29s here - as29s polls existing media on the page.
          // Real generation responses are captured in FLOW_REQUEST_CAPTURED below.
        }
      }
    } catch (e) {}
  },
  { urls: ['https://flow.google.com/*', 'https://flow.google.com/_/*'] },
  ['requestBody']
);

let _openingFlowTab = false;

async function captureTokenFromFlowTab({ createIfMissing = false } = {}) {
  let tabs = await chrome.tabs.query({ url: flowUrls });
  if (!tabs.length) {
    if (!createIfMissing) {
      console.log('[FrameWeaver] No Flow tab found — passive refresh skipped');
      return { skipped: 'NO_FLOW_TAB' };
    }
    if (_openingFlowTab) {
      console.log('[FrameWeaver] Flow tab already opening, skipping');
      return;
    }
    _openingFlowTab = true;
    try {
      console.log('[FrameWeaver] No Flow tab found — opening one for explicit refresh');
      const opened = await chrome.tabs.create({ url: FLOW_TAB_URL, active: false });
      await sleep(3000);
      const target = opened?.id ? await chrome.tabs.get(opened.id).catch(() => null) : null;
      if (!target) {
        console.log('[FrameWeaver] Flow tab not ready yet after open');
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: target.id },
        files: ['content.js'],
      });
      console.log('[FrameWeaver] Token refresh triggered on newly opened Flow tab');
    } catch (e) {
      console.error('[FrameWeaver] Token refresh failed after opening tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      files: ['content.js'],
    });
    console.log('[FrameWeaver] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[FrameWeaver] Token refresh failed:', e);
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch (e) {
    console.error('[FrameWeaver] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[FrameWeaver] Connected to agent');
    chrome.alarms.clear('reconnect');
    setState('idle');

    // Token refresh alarm — 45 min gives buffer before ~60 min expiry
    chrome.alarms.create('token-refresh', { periodInMinutes: 45 });

    // Send current state + resend token if we have one
    ws.send(JSON.stringify({
      type: 'extension_ready',
      flowKeyPresent: !!flowKey,
      extensionVersion: chrome.runtime.getManifest().version,
      flowUrlSupported: chrome.runtime.getManifest().host_permissions?.includes('https://flow.google.com/*') === true,
      tokenAge: flowKey && metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
    }));
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.method === 'batch_rpc') {
        await handleBatchRpc(msg);
      } else if (msg.method === 'ui_generate') {
        await handleUiGenerate(msg);
      } else if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.method === 'solve_captcha') {
        await handleSolveCaptcha(msg);
      } else if (msg.method === 'reload_extension') {
        sendToAgent({ id: msg.id, result: 'reloading' });
        setTimeout(() => chrome.runtime.reload(), 100);
      } else if (msg.method === 'eval_dom') {
        try {
          const tabs = await chrome.tabs.query({ url: flowUrls });
          let tab = tabs.find((t) => !t.discarded) || tabs[0];
          if (!tab) { sendToAgent({ id: msg.id, status: 503, error: 'NO_FLOW_TAB' }); return; }
          const code = msg.params?.code || 'return document.title;';
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (scriptCode) => {
              try {
                return { ok: true, value: new Function(scriptCode)() };
              } catch (e) {
                return { ok: false, error: e.message };
              }
            },
            args: [code]
          });
          sendToAgent({ id: msg.id, status: 200, result: res?.result });
        } catch (e) {
          sendToAgent({ id: msg.id, status: 500, error: e.message });
        }
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      } else if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[FrameWeaver] Received callback secret');
      } else if (msg.type === 'pong') {
        // keepalive response
      }
    } catch (e) {
      console.error('[FrameWeaver] Message error:', e);
    }
  };

  ws.onclose = () => {
    setState('off');
    chrome.alarms.clear('token-refresh');
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[FrameWeaver] WS error:', e);
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

function sendToAgent(msg) {
  // API responses (with msg.id) go via HTTP — immune to WS disconnect
  if (msg.id) {
    fetch('http://127.0.0.1:8100/api/ext/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP failed — fallback to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, status) or no secret yet — use WS
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    // Inject content script and retry
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  }
}

/** Try to wake a discarded Flow tab so `sendMessage` can reach it.
 *  Chrome auto-discards backgrounded tabs to save memory; the tab still shows
 *  up in `chrome.tabs.query` but cross-context calls fail with "No current
 *  window" / "No tab with id". A reload re-hydrates it. */
async function reviveTabIfNeeded(tab) {
  if (!tab?.discarded) return tab;
  try {
    await chrome.tabs.reload(tab.id);
    await sleep(2500);
    return await chrome.tabs.get(tab.id);
  } catch {
    return null;
  }
}

function captchaFromTab(tabId, requestId, captchaAction) {
  const prepare = (async () => {
    // reCAPTCHA Enterprise scores the actual visible Flow page. A background
    // tab can mint a token that Flow rejects as unusual activity even though
    // the same prompt succeeds when the page is foregrounded.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await chrome.tabs.update(tabId, { active: true });
      await sleep(500);
    } catch {}
    return requestCaptchaFromTab(tabId, requestId, captchaAction);
  })();
  return Promise.race([
    prepare,
    new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
  ]);
}

async function solveCaptcha(requestId, captchaAction) {
  let tabs = await chrome.tabs.query({ url: flowUrls });

  // No Flow tab at all — spawn one and let it settle. Keep the exact tab id:
  // a redirected or stale tab must not make us select some older candidate.
  if (!tabs.length) {
    let opened;
    try {
      opened = await chrome.tabs.create({ url: FLOW_TAB_URL, active: false });
      await sleep(3000);
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
    const target = opened?.id ? await chrome.tabs.get(opened.id).catch(() => null) : null;
    if (!target) return { error: 'NO_FLOW_TAB' };
    tabs = [target];
  }

  // Try each Flow tab in turn. A tab that answers "no grecaptcha" is a tab
  // sitting on a page that never loaded it — another Flow tab may well be
  // fine. Returning on the first one let one stale tab veto every generation.
  const errors = [];
  for (const candidate of tabs) {
    const tab = await reviveTabIfNeeded(candidate);
    if (!tab) continue;
    try {
      const resp = await captchaFromTab(tab.id, requestId, captchaAction);
      if (!resp?.token) {
        errors.push(resp?.error || 'NO_TOKEN');
        continue;
      }
      return resp;
    } catch (e) {
      const msg = e?.message || '';
      errors.push(msg);
      // Tab evaporated mid-call (window closed, discarded again, navigated
      // away). Move on to the next candidate rather than failing the job.
      if (
        msg.includes('No current window') ||
        msg.includes('No tab with id') ||
        msg.includes('Receiving end does not exist')
      ) {
        continue;
      }
      return { error: msg };
    }
  }

  // Every candidate failed — last-ditch, spawn a fresh temporary tab and
  // target THAT exact tab. Previously we re-queried all Flow tabs and picked
  // fresh[0], which could select the same stale tab again while leaking the
  // newly-created one on every retry.
  let recoveryTab = null;
  try {
    recoveryTab = await chrome.tabs.create({ url: FLOW_TAB_URL, active: false });
    await sleep(3000);
    const target = await chrome.tabs.get(recoveryTab.id);
    if (!target || target.discarded) return { error: 'NO_FLOW_TAB' };
    return await captchaFromTab(target.id, requestId, captchaAction);
  } catch (e) {
    return { error: e?.message || errors[0] || 'NO_FLOW_TAB' };
  } finally {
    // A recovery tab is disposable: there were already Flow tabs available
    // for the signed RPC. Do not let CAPTCHA retries accumulate root tabs.
    if (recoveryTab?.id) {
      try { await chrome.tabs.remove(recoveryTab.id); } catch { /* already gone */ }
    }
  }
}

async function handleSolveCaptcha(msg) {
  const { id, params } = msg;
  const result = await solveCaptcha(id, params?.captchaAction || 'VIDEO_GENERATION');

  // Standalone captcha solve counts as captcha-consuming
  metrics.requestCount++;
  if (result?.token) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
    metrics.lastError = result?.error || 'NO_TOKEN';
  }
  chrome.storage.local.set({ metrics });

  sendToAgent({ id, result });
}

// ─── Page-context RPC runner (the current path) ─────────────
//
// Flow's frontend signs its calls with cookies and a per-page `at` token, and
// every generate carries a single-use reCAPTCHA. None of that can be replayed
// from the service worker, so the request has to be issued by the Flow page
// itself: mint a fresh captcha through the grecaptcha bridge, then run the
// batchexecute POST in the page's MAIN world, where at / f.sid / bl live.

const CAPTCHA_SLOT = '__CAPTCHA__';
const MAX_RPC_TEXT = 32000000; // the project listing alone is past 17 MB

async function clickElementViaDebugger(tabId, x, y) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1
    });
    await sleep(60);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1
    });
    await sleep(50);
    await chrome.debugger.detach({ tabId });
    return { ok: true };
  } catch (err) {
    try { await chrome.debugger.detach({ tabId }); } catch(e){}
    return { error: err?.message || String(err) };
  }
}

async function runBatchRpc(cmd) {
  const tabs = await chrome.tabs.query({ url: flowUrls });
  let candidate = tabs.find((t) => !t.discarded) || tabs[0];
  if (!candidate) {
    // A fresh profile may have no Flow tab after Chrome restores the
    // extension. Open the project page so the signed-in session can load its
    // page token before the RPC and captcha are sent. If this profile is not
    // signed in, the normal profile failover path reports that locally and
    // tries another connected profile.
    const freqText = String(cmd.freq || '');
    // The video envelope contains a source media UUID before the project
    // UUID, so anchor the extraction to Flow's surface context (22).
    const projectId = freqText.match(
      /,22,null,null,null,["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/i,
    )?.[1] || freqText.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )?.[0];
    const url = projectId
      ? `https://flow.google.com/u/0/project/${projectId}`
      : FLOW_TAB_URL;
    try {
      candidate = await chrome.tabs.create({ url, active: true });
      await sleep(4000);
      if (candidate?.windowId != null) {
        await chrome.windows.update(candidate.windowId, { focused: true });
      }
      candidate = candidate?.id != null
        ? await chrome.tabs.get(candidate.id)
        : null;
    } catch (e) {
      return { error: e?.message || 'NO_FLOW_TAB' };
    }
    if (!candidate) return { error: 'NO_FLOW_TAB' };
  }
  // Chrome discards backgrounded tabs; executeScript throws on a dead one.
  const tab = await reviveTabIfNeeded(candidate);
  if (!tab) return { error: 'FLOW_TAB_DISCARDED' };

  let freq = cmd.freq;
  if (cmd.captchaAction) {
    const solved = await solveCaptcha(cmd.id, cmd.captchaAction);
    if (!solved?.token) return { error: `CAPTCHA_FAILED: ${solved?.error || 'no token'}` };
    freq = freq.split(CAPTCHA_SLOT).join(solved.token);
  }

  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [cmd.rpcid, freq, MAX_RPC_TEXT, cmd.match || null],
    func: async (rpcid, freqStr, maxText, match) => {
      try {
        const wiz = globalThis.WIZ_global_data || {};
      const at = wiz.SNlM0e;
      const sid = wiz.FdrFJe;
      const bl = wiz.cfb2h;
      if (!at) return { error: 'NO_AT_TOKEN' };
      const reqid = Math.floor(Math.random() * 900000) + 100000;
      // Match Flow's own WIZ metadata. GEM_PIX_2 (Nano Banana Pro) rejects
      // image generation when source-path is missing even though Lite may not.
      const sourcePath = location.pathname || '/';
      const hl = (document.documentElement.lang || navigator.language || 'en').split('-')[0];
      const isStream = rpcid.includes('StreamChat') || rpcid.includes('FlowCreationAgentService');
      const url = isStream
        ? `/_/AiSandboxAngularFrontend/data/google.internal.labs.aisandbox.proto.flow.agent.v1.FlowCreationAgentService/StreamChat` +
          `?bl=${encodeURIComponent(bl || '')}&f.sid=${encodeURIComponent(sid || '')}` +
          `&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`
        : `/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${encodeURIComponent(rpcid)}` +
          `&source-path=${encodeURIComponent(sourcePath)}` +
          `&bl=${encodeURIComponent(bl || '')}&f.sid=${encodeURIComponent(sid || '')}` +
          `&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: new URLSearchParams({ 'f.req': freqStr, at }),
      });
      const text = await resp.text();
      // The project listing is tens of megabytes and all we ever want from it
      // is one entry. Cutting it down here keeps that payload inside the tab
      // instead of pushing it through the bridge on every poll.
      if (match) {
        const found = text.indexOf(match);   // not `at` — that is the CSRF token above
        return {
          status: resp.status,
          matched: found !== -1,
          text: found === -1 ? '' : text.slice(found, found + 800),
        };
      }
      return { status: resp.status, text: text.slice(0, maxText) };
      } catch (err) {
        return { error: err?.message || String(err), stack: err?.stack };
      }
    },
  });

  return injected?.result || { error: 'NO_INJECTION_RESULT' };
}

async function handleBatchRpc(msg) {
  const { id, params } = msg;
  const { rpcid, freq, captchaAction, match } = params || {};
  if (!rpcid || !freq) {
    sendToAgent({ id, status: 400, error: 'INVALID_BATCH_RPC' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;
  // Polls and listing lookups run constantly; only the generates are worth
  // a row in the log the popup shows.
  const visible = hasCaptcha;
  if (visible) {
    addRequestLog({
      id, type: `RPC:${rpcid}`, time: new Date().toISOString(),
      status: 'processing', error: null, outputUrl: null, url: rpcid,
      payloadSummary: freq.slice(0, 200),
    });
  }

  try {
    const out = await runBatchRpc({ id, rpcid, freq, captchaAction, match });
    if (out.error) {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = out.error; }
      if (visible) updateRequestLog(id, { status: 'failed', error: out.error });
      sendToAgent({ id, status: 502, error: out.error });
    } else {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      if (visible) {
        updateRequestLog(id, {
          status: 'success', httpStatus: out.status,
          responseSummary: (out.text || '').slice(0, 300),
        });
      }
      sendToAgent({ id, status: out.status, data: out.text });
    }
  } catch (e) {
    const err = e?.message || 'BATCH_RPC_FAILED';
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = err; }
    if (visible) updateRequestLog(id, { status: 'failed', error: err });
    sendToAgent({ id, status: 500, error: err });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── Native UI Generation Bridge (reCAPTCHA Enterprise bypass) ───

async function handleUiGenerate(msg) {
  const { id, params } = msg;
  const { prompt, type = 'IMAGE', aspect_ratio = 'LANDSCAPE', project_id } = params || {};
  if (!prompt) {
    sendToAgent({ id, status: 400, error: 'PROMPT_REQUIRED' });
    return;
  }

  setState('running');
  const tabs = await chrome.tabs.query({ url: flowUrls });
  let tab = null;
  if (project_id) {
    tab = tabs.find((t) => t.url?.includes(project_id) && !t.discarded) ||
          tabs.find((t) => t.url?.includes(project_id));
  }
  if (!tab) {
    tab = tabs.find((t) => !t.discarded) || tabs[0];
  }
  if (!tab) {
    setState('idle');
    sendToAgent({ id, status: 503, error: 'NO_FLOW_TAB' });
    return;
  }

  if (project_id && tab.url && !tab.url.includes(project_id)) {
    try {
      await chrome.tabs.update(tab.id, { url: `https://flow.google.com/project/${project_id}`, active: true });
      await sleep(3500);
      tab = await chrome.tabs.get(tab.id);
    } catch {}
  }

  try {
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await sleep(200);

    let capturedResult = null;
    let captureResolver = null;
    const capturePromise = new Promise((resolve) => {
      captureResolver = resolve;
    });

    _uiGenerateListener = (reqType, payload) => {
      if (reqType === type && !capturedResult) {
        capturedResult = payload;
        if (captureResolver) captureResolver(payload);
      }
    };
    _uiGenerateListener.projectId = project_id;
    _uiGenerateListener.type = type;

    // 1. Prepare prompt box & check mode
    const [prep] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [type, aspect_ratio],
      func: async (targetType) => {
        const closeBtn = Array.from(document.querySelectorAll('button')).find(b =>
          b.innerText?.includes('close') || b.getAttribute('aria-label') === 'Close'
        );
        if (closeBtn && document.querySelector('FLOW-SETTINGS-VIEW')) {
          closeBtn.click();
          await new Promise(r => setTimeout(r, 200));
        }

        const box = document.querySelector('FLOW-BASE-PROMPT-BOX') || document.body;
        const trigger = box.querySelector('.settings-trigger-button') ||
          Array.from(box.querySelectorAll('button')).find(b =>
            b.innerText?.includes('Video') || b.innerText?.includes('Banana') || b.getAttribute('aria-label') === 'Settings trigger'
          );

        const currentText = trigger?.innerText || '';
        const isVideoNow = currentText.includes('Video');
        const wantVideo = (targetType === 'VIDEO');

        if (isVideoNow !== wantVideo && trigger) {
          const r = trigger.getBoundingClientRect();
          return {
            needSwitch: true,
            triggerX: Math.round(r.left + r.width / 2),
            triggerY: Math.round(r.top + r.height / 2),
          };
        }

        return { needSwitch: false };
      }
    });

    if (prep?.result?.needSwitch) {
      await clickElementViaDebugger(tab.id, prep.result.triggerX, prep.result.triggerY);
      await sleep(400);

      const [overlayRes] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [type],
        func: (targetType) => {
          const btns = Array.from(document.querySelectorAll('.cdk-overlay-container button, .cdk-overlay-container [role="button"], .cdk-overlay-container mat-button-toggle'));
          const keyword = (targetType === 'VIDEO') ? 'video' : 'image';
          const match = btns.find(b => b.innerText?.toLowerCase().includes(keyword));
          if (!match) return { error: `NO_${keyword.toUpperCase()}_BUTTON` };
          const r = match.getBoundingClientRect();
          return {
            ok: true,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2)
          };
        }
      });

      if (overlayRes?.result?.ok) {
        await clickElementViaDebugger(tab.id, overlayRes.result.x, overlayRes.result.y);
        await sleep(400);
      }
    }

    // 2. Fill ProseMirror & locate Start generation button
    const [fillRes] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [prompt],
      func: async (textPrompt) => {
        let pm = document.querySelector('.ProseMirror');
        if (!pm) {
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 250));
            pm = document.querySelector('.ProseMirror');
            if (pm) break;
          }
        }
        if (!pm) return { error: 'NO_PROSEMIRROR' };
        pm.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(pm);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete');
        pm.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: textPrompt, bubbles: true, cancelable: true }));
        document.execCommand('insertText', false, textPrompt);
        pm.dispatchEvent(new Event('input', { bubbles: true }));

        let genBtn = document.querySelector('button[aria-label="Start generation"]');
        if (!genBtn) {
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 250));
            genBtn = document.querySelector('button[aria-label="Start generation"]');
            if (genBtn) break;
          }
        }
        if (!genBtn) return { error: 'NO_GEN_BTN' };
        const r = genBtn.getBoundingClientRect();
        return {
          ok: true,
          submitX: Math.round(r.left + r.width / 2),
          submitY: Math.round(r.top + r.height / 2)
        };
      }
    });

    if (!fillRes?.result?.ok) {
      setState('idle');
      sendToAgent({ id, status: 500, error: fillRes?.result?.error || 'FILL_PROMPT_FAILED' });
      return;
    }

    // 3. Submit click via debugger
    await clickElementViaDebugger(tab.id, fillRes.result.submitX, fillRes.result.submitY);

    // 4. Wait for network capture or DOM update
    const timeoutMs = (type === 'VIDEO') ? 260000 : 120000;
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const captured = await Promise.race([capturePromise, timeoutPromise]);

    if (captured) {
      setState('idle');
      sendToAgent({ id, status: 200, result: captured });
      return;
    }

    setState('idle');
    sendToAgent({ id, status: 504, error: 'UI_GENERATION_TIMEOUT' });
  } catch (err) {
    setState('idle');
    sendToAgent({ id, status: 500, error: err?.message || String(err) });
  } finally {
    _uiGenerateListener = null;
  }
}

// ─── API Request Proxy ──────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body, responseMode = 'json' } = params;

  if (!url || !url.startsWith('https://labs.google/')) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls don't consume captcha — don't count in metrics

  const logId = id;
  const logType = url.includes('createProject') ? 'CREATE_PROJECT' : 'TRPC';
  // TRPC calls are silent — don't show in request log

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    let data;
    if (responseMode === 'url') {
      // fetch() has already followed the authenticated Flow redirect. Return
      // only the final signed URL and cancel the body so large videos are not
      // buffered in the extension or copied through the WebSocket bridge.
      data = {
        url: resp.url,
        contentType: resp.headers.get('content-type'),
      };
      await resp.body?.cancel();
    } else {
      data = await resp.json();
    }
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'success' });
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[FrameWeaver] tRPC request failed:', e);
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'failed', error: e.message || 'TRPC_FETCH_FAILED' });
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

// Legacy REST proxy against aisandbox-pa. No current agent sends `api_request`;
// kept only so an extension updated ahead of its agent still serves an older
// one. It needs a `Bearer ya29.…` that Flow stopped minting, so it 401s on any
// post-migration profile — as does sendTelemetry below, which early-returns
// without a flowKey. Nothing here reaches aisandbox-pa any more; when the
// oldest agent in the wild speaks batch_rpc, this and the host permission go.
async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params;

  if (!url) {
    sendToAgent({ id, error: 'MISSING_URL' });
    return;
  }

  if (!url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  const logId = id;
  const logType = _classifyApiUrl(url);
  if (_VISIBLE_TYPES.has(logType)) {
    const payloadSummary = body ? JSON.stringify(body).slice(0, 200) : null;
    addRequestLog({ id: logId, type: logType, time: new Date().toISOString(), status: 'processing', error: null, outputUrl: null, url, payloadSummary });
  }

  try {
    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        // Cannot proceed without captcha — API will 403
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[FrameWeaver] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(logId, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    // Step 3: Use flowKey for auth
    const activeFlowKey = flowKey;
    if (!activeFlowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(logId, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    const fetchHeaders = { ...(headers || {}) };
    fetchHeaders['authorization'] = `Bearer ${activeFlowKey}`;

    // Step 4: Make the API call from browser context
    const response = await fetch(url, {
      method: method || 'POST',
      headers: fetchHeaders,
      credentials: 'include',
      body: method === 'GET' ? undefined : JSON.stringify(finalBody),
    });

    let responseData;
    const responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    sendToAgent({
      id,
      status: response.status,
      data: responseData,
    });

    const responseSummary = responseText ? responseText.slice(0, 300) : null;
    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(logId, { status: 'success', httpStatus: response.status, responseSummary });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${response.status}`; }
      updateRequestLog(logId, { status: 'failed', error: `API_${response.status}`, httpStatus: response.status, responseSummary });
    }
  } catch (e) {
    sendToAgent({
      id,
      status: 500,
      error: e.message || 'API_REQUEST_FAILED',
    });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message; }
    updateRequestLog(logId, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── State & Popup ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f59e0b', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[state] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[state] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    reply({
      connected: ws?.readyState === WebSocket.OPEN,
      agentConnected: ws?.readyState === WebSocket.OPEN,
      flowKeyPresent: !!flowKey,
      manualDisconnect,
      tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount: metrics.failedCount,
        lastError: metrics.lastError,
      },
      state,
    });
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    if (ws) ws.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({ url: flowUrls }).then((tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        reply({ ok: true, tabId: tabs[0].id });
      } else {
        chrome.tabs.create({ url: FLOW_TAB_URL })
          .then((tab) => reply({ ok: true, tabId: tab.id }))
          .catch((e) => reply({ error: e.message }));
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab({ createIfMissing: true })
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TEST_CAPTCHA') {
    solveCaptcha(`test-${Date.now()}`, msg.pageAction || 'IMAGE_GENERATION')
      .then((r) => reply(r))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TRPC_MEDIA_URLS') {
    handleTrpcMediaUrls(msg.trpcUrl, msg.body);
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'FLOW_REQUEST_CAPTURED') {
    metrics.capturedFlow = msg.data;
    chrome.storage.local.set({ metrics });
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'captured_flow', data: msg.data }));
    }

    if (_uiGenerateListener && msg.data?.direction === 'response') {
      const url = msg.data.url || '';
      const text = msg.data.text || '';
      const pid = _uiGenerateListener.projectId;

      if (_uiGenerateListener.type === 'IMAGE' && (url.includes('ogiZ0b') || url.includes('StreamChat') || url.includes('bOKtO'))) {
        const matches = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi) || [];
        const newIds = matches.filter(id => id.toLowerCase() !== pid?.toLowerCase());
        if (newIds.length > 0) {
          const generatedId = newIds[0];
          console.log('[FrameWeaver] Captured fresh IMAGE from response:', generatedId);
          _uiGenerateListener('IMAGE', {
            media: [{
              name: generatedId,
              media_id: generatedId,
              url: `https://flow-content.google/image/${generatedId}`
            }]
          });
        }
      } else if (_uiGenerateListener.type === 'VIDEO' && (url.includes('YhhmEf') || url.includes('eb1hJf') || url.includes('ngNC2') || url.includes('as29s'))) {
        const matches = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi) || [];
        const newIds = matches.filter(id => id.toLowerCase() !== pid?.toLowerCase());
        if (newIds.length > 0) {
          const generatedId = newIds[0];
          console.log('[FrameWeaver] Captured fresh VIDEO from response:', generatedId);
          _uiGenerateListener('VIDEO', {
            operations: [{
              operation: { name: generatedId },
              status: 'MEDIA_GENERATION_STATUS_PENDING'
            }]
          });
        }
      }
    }

    reply({ ok: true });
    return true;
  }

  return true;
});

// ─── TRPC Media URL Extractor ──────────────────────────────

function handleTrpcMediaUrls(trpcUrl, bodyText) {
  try {
    // Extract all fresh GCS signed URLs
    const urlRegex = /https:\/\/storage\.googleapis\.com\/ai-sandbox-videofx\/(?:image|video)\/[0-9a-f-]{36}\?[^"'\s]+/g;
    const matches = bodyText.match(urlRegex) || [];
    if (!matches.length) return;

    // Deduplicate and parse
    const urlMap = {};
    for (const rawUrl of matches) {
      // Unescape JSON-escaped URLs
      const url = rawUrl.replace(/\\u0026/g, '&').replace(/\\/g, '');
      const mediaMatch = url.match(/\/(image|video)\/([0-9a-f-]{36})\?/);
      if (mediaMatch) {
        const [, mediaType, mediaId] = mediaMatch;
        // Keep last occurrence (freshest)
        urlMap[mediaId] = { mediaType, url, mediaId };
      }
    }

    const entries = Object.values(urlMap);
    if (!entries.length) return;

    console.log(`[FrameWeaver] Captured ${entries.length} fresh media URLs from TRPC`);
    // URL refresh is silent — don't show in request log

    // Forward to agent for DB update
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'media_urls_refresh',
        urls: entries,
      }));
    }
  } catch (e) {
    console.error('[FrameWeaver] Failed to extract TRPC media URLs:', e);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Human-like Telemetry ──────────────────────────────────
// Periodically send tracking events to Google's analytics endpoints
// to mimic normal browser behavior.

const _UA = navigator.userAgent;
let _telemetrySessionId = `;${Date.now()}`;

function _rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function _buildBatchLogPayload() {
  const events = [];
  const types = ['FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY'];
  const count = _rand(1, 3);
  for (let i = 0; i < count; i++) {
    events.push({
      event: types[_rand(0, types.length - 1)],
      eventProperties: [
        { key: 'CURRENT_TIME_MS', doubleValue: Date.now() },
        { key: 'DURATION_MS', doubleValue: _rand(150, 800) },
        { key: 'USER_AGENT', stringValue: _UA },
        { key: 'IS_DESKTOP', booleanValue: true },
      ],
      eventMetadata: { sessionId: _telemetrySessionId },
      eventTime: new Date().toISOString(),
    });
  }
  return { appEvents: events };
}

function _buildFrontendEventsPayload() {
  const eventTypes = [
    'FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY', 'GRID_SCROLL_DEPTH',
    'FLOW_PROJECT_OPEN', 'FLOW_SCENE_VIEW',
  ];
  const count = _rand(1, 4);
  const events = [];
  for (let i = 0; i < count; i++) {
    const et = eventTypes[_rand(0, eventTypes.length - 1)];
    const params = {
      USER_AGENT: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: _UA },
      IS_DESKTOP: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'true' },
    };
    if (et.includes('LATENCY')) {
      params.CURRENT_TIME_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(Date.now()) };
      params.DURATION_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(_rand(100, 600)) };
    }
    if (et === 'GRID_SCROLL_DEPTH') {
      params.MEDIA_GENERATION_PAYGATE_TIER = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'PAYGATE_TIER_TWO' };
    }
    events.push({
      eventType: et,
      metadata: {
        sessionId: _telemetrySessionId,
        createTime: new Date().toISOString(),
        additionalParams: params,
      },
    });
  }
  return { events };
}

async function sendTelemetry() {
  // Legacy-path camouflage: these endpoints want the bearer Flow no longer
  // mints, so on the batch path there is no flowKey and this is a no-op.
  if (!flowKey || state === 'off') return;

  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    'authorization': `Bearer ${flowKey}`,
  };

  // Telemetry is silent — don't show in request log
  try {
    if (Math.random() < 0.5) {
      await fetch(`https://aisandbox-pa.googleapis.com/v1:batchLog`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildBatchLogPayload()),
      });
    } else {
      await fetch(`https://aisandbox-pa.googleapis.com/v1/flow:batchLogFrontendEvents`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildFrontendEventsPayload()),
      });
    }
  } catch {}
}

// Send telemetry at random intervals (45-120s) to look organic
function scheduleTelemetry() {
  const delay = _rand(45, 120) * 1000;
  setTimeout(async () => {
    await sendTelemetry();
    scheduleTelemetry(); // reschedule with new random interval
  }, delay);
}

// Refresh session ID every ~30min like a real user
setInterval(() => { _telemetrySessionId = `;${Date.now()}`; }, _rand(25, 35) * 60 * 1000);

scheduleTelemetry();

console.log('[FrameWeaver] Extension loaded');
