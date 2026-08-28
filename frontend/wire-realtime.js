// FILE: frontend/wire-realtime.js
// Training Wire — realtime layer.
// Wraps the Web PubSub client socket. Negotiates a signed URL via WireClient,
// connects, auto-reconnects with backoff, and dispatches the five server event
// types (release / publish / flag / clear) to registered handlers. On every
// (re)connect it fires an 'resync' callback so the app can pull /api/state and
// guarantee it never misses events during a drop.
'use strict';

(function () {
  const EVENTS = ['release', 'publish', 'flag', 'clear'];

  class WireRealtime {
    constructor() {
      this._ws = null;
      this._url = null;
      this._group = null;
      this._handlers = {};      // type -> fn
      this._statusHandler = null;
      this._resyncHandler = null;
      this._shouldRun = false;
      this._reconnectAttempts = 0;
      this._reconnectTimer = null;
      this._heartbeatTimer = null;
      this._connected = false;
    }

    on(type, fn) { this._handlers[type] = fn; return this; }
    onStatus(fn) { this._statusHandler = fn; return this; }
    onResync(fn) { this._resyncHandler = fn; return this; }

    _emitStatus(status) {
      if (this._statusHandler) { try { this._statusHandler(status); } catch (e) {} }
    }

    async start() {
      this._shouldRun = true;
      await this._connect();
    }

    stop() {
      this._shouldRun = false;
      this._clearTimers();
      if (this._ws) {
        try { this._ws.close(); } catch (e) {}
        this._ws = null;
      }
      this._connected = false;
      this._emitStatus('offline');
    }

    _clearTimers() {
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    }

    async _connect() {
      if (!this._shouldRun) return;
      this._emitStatus('connecting');

      // Get a fresh signed URL every connect — they're short-lived by design.
      try {
        const neg = await window.WireClient.negotiate();
        this._url = neg.url;
        this._group = neg.group || null;
      } catch (e) {
        // If negotiate 401s, WireClient already cleared tokens; bubble up as offline.
        this._emitStatus('offline');
        return this._scheduleReconnect();
      }

      let ws;
      try {
        // Web PubSub supports the json.reliable.webpubsub.azure.v1 subprotocol,
        // but for broadcast-to-group we use the simple json protocol.
        ws = new WebSocket(this._url, 'json.webpubsub.azure.v1');
      } catch (e) {
        return this._scheduleReconnect();
      }
      this._ws = ws;

      ws.onopen = () => {
        this._connected = true;
        this._reconnectAttempts = 0;
        this._emitStatus('online');
        // Fire resync so the app pulls the authoritative snapshot and can't have
        // missed anything while it was disconnected.
        if (this._resyncHandler) { try { this._resyncHandler(); } catch (e) {} }
        this._startHeartbeat();
      };

      ws.onmessage = (evt) => this._onMessage(evt);

      ws.onerror = () => { /* onclose will handle the reconnect */ };

      ws.onclose = () => {
        this._connected = false;
        this._clearTimers();
        this._ws = null;
        if (this._shouldRun) {
          this._emitStatus('reconnecting');
          this._scheduleReconnect();
        } else {
          this._emitStatus('offline');
        }
      };
    }

    _startHeartbeat() {
      // Web PubSub handles keepalive at the protocol level, but a light client
      // ping guards against silent half-open sockets behind corporate proxies.
      this._heartbeatTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
          try {
            this._ws.send(JSON.stringify({ type: 'event', event: 'ping', dataType: 'json', data: { t: Date.now() } }));
          } catch (e) {}
        }
      }, 30000);
    }

    _scheduleReconnect() {
      if (!this._shouldRun) return;
      this._reconnectAttempts += 1;
      // Exponential backoff, capped at 15s, with jitter.
      const base = Math.min(15000, 1000 * Math.pow(2, this._reconnectAttempts - 1));
      const jitter = Math.random() * 500;
      const delay = base + jitter;
      this._reconnectTimer = setTimeout(() => this._connect(), delay);
    }

    _onMessage(evt) {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }

      // Web PubSub wraps group/server messages. The actual payload we broadcast
      // from the backend sits in msg.data. Unwrap defensively across shapes.
      let payload = null;
      if (msg.type === 'message' && msg.data !== undefined) {
        payload = msg.data;
      } else if (msg.data !== undefined) {
        payload = msg.data;
      } else {
        payload = msg;
      }

      // Payload can be a JSON string depending on dataType — normalise.
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { return; }
      }
      if (!payload || typeof payload !== 'object') return;

      const type = payload.type;
      if (!EVENTS.includes(type)) return;    // ignore ping acks / system frames

      const handler = this._handlers[type];
      if (handler) {
        try { handler(payload.payload !== undefined ? payload.payload : payload); }
        catch (e) { /* never let one bad frame kill the socket */ }
      }
    }

    get connected() { return this._connected; }
  }

  window.WireRealtime = new WireRealtime();
})();