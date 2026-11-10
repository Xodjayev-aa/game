/* ============================================================
   RoFrontier — free public relay (free-relay.js)
   ------------------------------------------------------------
   A zero-cost, zero-account, cross-device broadcast bus for the
   online lobby + lockstep match. Uses MQTT 3.1.1 over secure
   WebSockets against free public test brokers — no server to pay
   for, no API keys, no signup. It is a *dumb broadcast bus*: room
   authority and ordering live in game.js (RoomHost/LobbyClient).

   If every broker is unreachable (or the device is offline), the
   game automatically falls back to its local lobby simulation, and
   offline campaigns remain fully playable.

   Packet layout implemented here (pure browser APIs, no deps):
     CONNECT / CONNACK / SUBSCRIBE / SUBACK / PUBLISH(QoS 0)
     PINGREQ / PINGRESP  + MQTT remaining-length varint
   ============================================================ */
(function (global) {
  'use strict';

  // Public anonymous brokers. All are free for testing; the first one that
  // accepts a connection is used. Self-host server.js for production.
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://broker.mqtt-dashboard.com:8884/mqtt',
    'wss://mqtt.eclipseprojects.io:443/mqtt'
  ];
  const TOPIC_PREFIX = 'rofrontier/v1/';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function utf8(str) {
    const bytes = encoder.encode(String(str));
    return [bytes.length >> 8, bytes.length & 255, ...bytes];
  }
  function remainingLength(len) {
    const out = [];
    let n = len;
    do {
      let digit = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) digit |= 0x80;
      out.push(digit);
    } while (n > 0);
    return out;
  }
  function readRemainingLength(bytes, offset) {
    let multiplier = 1, value = 0, i = offset, digit;
    do {
      if (i >= bytes.length) return [0, bytes.length];
      digit = bytes[i++];
      value += (digit & 127) * multiplier;
      multiplier *= 128;
    } while ((digit & 128) !== 0 && i - offset < 4);
    return [value, i];
  }

  class FreeRelay {
    /**
     * @param {object} opts
     * @param {Function} opts.onMessage (parsed JSON message) => void
     * @param {Function} opts.onStatus  ('open'|'failed'|'closed', detail) => void
     */
    constructor(opts = {}) {
      this.onMessage = opts.onMessage || (() => {});
      this.onStatus = opts.onStatus || (() => {});
      this.clientId = 'rf-' + Math.random().toString(36).slice(2, 10);
      this.ws = null;
      this.topic = null;
      this.connected = false;
      this.closed = false;
      this.brokerIndex = 0;
      this.pingTimer = null;
      this.buffer = new Uint8Array(0);
      this.packetId = 1;
    }

    get from() { return this.clientId; }

    connect() {
      if (this.closed) return;
      if (this.brokerIndex >= BROKERS.length) {
        this.onStatus('failed', 'All free public relays are unreachable.');
        return;
      }
      const url = BROKERS[this.brokerIndex++];
      this.url = url;
      let ws;
      try { ws = new WebSocket(url, 'mqtt'); }
      catch (err) { this.connect(); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timeout = setTimeout(() => {
        if (!this.connected && this.ws === ws) { try { ws.close(); } catch (_) {} }
      }, 3200);

      ws.addEventListener('open', () => {
        const clientId = utf8(this.clientId);
        // CONNECT: MQTT 3.1.1, clean session, 30s keep-alive, no credentials.
        const body = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x1e, ...clientId];
        this.sendBytes([0x10, ...remainingLength(body.length), ...body]);
      });
      ws.addEventListener('message', (event) => {
        const chunk = new Uint8Array(event.data);
        const merged = new Uint8Array(this.buffer.length + chunk.length);
        merged.set(this.buffer, 0);
        merged.set(chunk, this.buffer.length);
        this.buffer = merged;
        this.parse();
      });
      ws.addEventListener('error', () => { /* onclose drives retry */ });
      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (this.closed) return;
        if (this.connected) {
          this.connected = false;
          this.onStatus('closed', `Relay ${url} disconnected.`);
          this.brokerIndex = 0;
          // Reconnect to the same broker list after a short pause.
          setTimeout(() => this.connect(), 2500);
        } else {
          this.connect(); // try the next free broker
        }
      });
    }

    sendBytes(bytes) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(new Uint8Array(bytes));
    }

    parse() {
      const b = this.buffer;
      let offset = 0;
      while (b.length - offset >= 2) {
        const type = b[offset] >> 4;
        const [len, headerEnd] = readRemainingLength(b, offset + 1);
        if (len > 262144 || headerEnd + len > b.length) break; // wait for more bytes
        const payload = b.subarray(headerEnd, headerEnd + len);
        offset = headerEnd + len;
        if (type === 2) { // CONNACK
          if (payload[1] === 0) {
            this.connected = true;
            this.onStatus('open', this.url);
            if (this.topic) this.subscribe(this.topic.replace(TOPIC_PREFIX, ''));
            this.pingTimer = setInterval(() => this.sendBytes([0xc0, 0x00]), 25000);
          } else {
            try { this.ws.close(); } catch (_) {}
          }
        } else if (type === 9) { // SUBACK
          // subscription accepted
        } else if (type === 3) { // PUBLISH (QoS 0 from broker)
          const topicLen = (payload[0] << 8) | payload[1];
          const topic = decoder.decode(payload.subarray(2, 2 + topicLen));
          const data = payload.subarray(2 + topicLen);
          if (!this.topic || topic !== this.topic) continue;
          try {
            const msg = JSON.parse(decoder.decode(data));
            if (msg && typeof msg === 'object') this.onMessage(msg);
          } catch (_) { /* ignore malformed payloads from other clients */ }
        } else if (type === 13) { // PINGRESP
          // keep-alive acknowledged
        }
      }
      this.buffer = b.subarray(offset);
    }

    subscribe(code) {
      this.topic = TOPIC_PREFIX + String(code).toUpperCase();
      if (!this.connected) return;
      const id = this.packetId++;
      const body = [id >> 8, id & 255, ...utf8(this.topic), 0x00]; // QoS 0
      this.sendBytes([0x82, ...remainingLength(body.length), ...body]);
    }

    publish(msg) {
      if (!this.connected || !this.topic) return false;
      // The lobby layer already stamps `from` with its stable player id; keep
      // it so self-echo filtering and targeted replies work on every transport.
      const data = encoder.encode(JSON.stringify({ ...msg, from: msg.from || this.clientId }));
      const body = [...utf8(this.topic), ...data];
      this.sendBytes([0x30, ...remainingLength(body.length), ...body]);
      return true;
    }

    close() {
      this.closed = true;
      clearInterval(this.pingTimer);
      if (this.connected) this.sendBytes([0xe0, 0x00]); // DISCONNECT
      if (this.ws) { try { this.ws.close(); } catch (_) {} }
      this.connected = false;
      this.ws = null;
    }
  }

  global.RoFrontierFreeRelay = FreeRelay;
  global.RoFrontierFreeRelay.brokers = BROKERS;
})(typeof window !== 'undefined' ? window : globalThis);
