/* 操作台 2.8.4 朗读排队。纯逻辑，不持有密钥，不访问网络。
   整段最多 4000 字（与服务端 SPEAK_TEXT_MAX 一致）。按句切开后单段超过 800 字再硬切，
   切下来的都进队列，不丢句。超出 4000 的尾巴不念。 */
(function (root) {
  "use strict";
  var SPEAK_TEXT_MAX = 4000;
  var SPEAK_SLICE_MAX = 800;
  var LEGACY_CLIP = 500;

  function splitSpeakText(text, cap) {
    var limit = cap || SPEAK_TEXT_MAX;
    var s = String(text || "").replace(/\r\n/g, "\n").replace(/https?:\/\/\S+/g, "链接").trim();
    if (!s) return [];
    if (s.length > limit) s = s.slice(0, limit);
    var parts = [];
    var buf = "";
    function flush() {
      var t = buf.trim();
      buf = "";
      if (t) parts.push(t);
    }
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      buf += ch;
      var boundary = false;
      if (ch === "\n" || ch === "。" || ch === "！" || ch === "？" || ch === "!" || ch === "?") boundary = true;
      else if (ch === ".") {
        var prev = i > 0 ? s.charAt(i - 1) : "";
        var next = i + 1 < s.length ? s.charAt(i + 1) : "";
        var prevDigit = prev >= "0" && prev <= "9";
        var nextDigit = next >= "0" && next <= "9";
        if (!prevDigit && !nextDigit && next !== ".") boundary = true;
      }
      if (boundary || buf.length >= SPEAK_SLICE_MAX) flush();
    }
    flush();
    return parts;
  }

  function createSession() {
    var gen = 0;
    var parts = [];
    var cursor = 0;
    return {
      begin: function (text) {
        gen += 1;
        parts = splitSpeakText(text);
        cursor = 0;
        return { gen: gen, parts: parts.slice() };
      },
      cancel: function () {
        gen += 1;
        parts = [];
        cursor = 0;
        return gen;
      },
      next: function (g) {
        if (g !== gen || cursor >= parts.length) return null;
        var part = parts[cursor];
        cursor += 1;
        return part;
      },
      pending: function (g) {
        if (g !== gen) return [];
        return parts.slice(cursor);
      },
      generation: function () { return gen; }
    };
  }

  function createWavPump() {
    var pending = new Uint8Array(0);
    var dataOffset = -1;
    var rate = 24000;
    var unsupported = false;

    function append(chunk) {
      if (!chunk || !chunk.length) return;
      var next = new Uint8Array(pending.length + chunk.length);
      next.set(pending, 0);
      next.set(chunk, pending.length);
      pending = next;
    }
    function fourcc(offset) {
      var s = "";
      for (var i = 0; i < 4; i++) s += String.fromCharCode(pending[offset + i]);
      return s;
    }
    function parseHeader() {
      if (pending.length < 44) return false;
      if (fourcc(0) !== "RIFF" || fourcc(8) !== "WAVE") {
        unsupported = true;
        return false;
      }
      var view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
      var offset = 12;
      var found = -1;
      while (offset + 8 <= pending.length && offset < 256) {
        var kind = fourcc(offset);
        var size = view.getUint32(offset + 4, true);
        if (kind === "fmt ") {
          if (offset + 24 > pending.length) return false;
          var format = view.getUint16(offset + 8, true);
          var channels = view.getUint16(offset + 10, true);
          rate = view.getUint32(offset + 12, true) || 24000;
          var bits = view.getUint16(offset + 22, true);
          if (format !== 1 || channels !== 1 || bits !== 16) {
            unsupported = true;
            return false;
          }
        }
        if (kind === "data") {
          found = offset + 8;
          break;
        }
        var step = 8 + size + (size % 2);
        if (step <= 0) break;
        offset += step;
      }
      if (found < 0) {
        if (pending.length > 256) unsupported = true;
        return false;
      }
      dataOffset = found;
      return true;
    }

    function push(chunk) {
      if (unsupported) return { samples: null, unsupported: true, rate: rate };
      append(chunk);
      if (dataOffset < 0) {
        var ok = parseHeader();
        if (unsupported) return { samples: null, unsupported: true, rate: rate };
        if (!ok) return { samples: new Int16Array(0), ready: false, rate: rate };
      }
      var pcm = pending.subarray(dataOffset);
      var even = pcm.length - (pcm.length % 2);
      if (even <= 0) return { samples: new Int16Array(0), ready: true, rate: rate };
      var samples = new Int16Array(even / 2);
      for (var i = 0; i < samples.length; i++) {
        var v = pcm[i * 2] | (pcm[i * 2 + 1] << 8);
        if (v & 0x8000) v -= 0x10000;
        samples[i] = v;
      }
      var rest = pcm.subarray(even);
      var keep = new Uint8Array(rest.length);
      if (rest.length) keep.set(rest);
      pending = keep;
      dataOffset = 0;
      return { samples: samples, ready: true, rate: rate };
    }
    return { push: push };
  }

  /* events: [{ t: 毫秒, bytes: Uint8Array }]。头到达还不能听，要有 PCM 采样才算可觉播。
     fullBufferMs 是旧路径 arrayBuffer 要等到的时刻。 */
  function audibleTimeline(events) {
    var pump = createWavPump();
    var first = null;
    var last = 0;
    var samples = 0;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      last = ev.t;
      var out = pump.push(ev.bytes);
      if (out && out.samples && out.samples.length) {
        samples += out.samples.length;
        if (first === null) first = ev.t;
      }
    }
    return { firstAudibleMs: first, fullBufferMs: last, samples: samples };
  }

  function legacyVersusStream(events) {
    var times = audibleTimeline(events);
    return {
      beforeMs: times.fullBufferMs,
      afterMs: times.firstAudibleMs,
      savedMs: (times.fullBufferMs == null || times.firstAudibleMs == null) ? null : times.fullBufferMs - times.firstAudibleMs,
      samples: times.samples
    };
  }

  root.SBSpeakQueue = {
    SPEAK_TEXT_MAX: SPEAK_TEXT_MAX,
    SPEAK_SLICE_MAX: SPEAK_SLICE_MAX,
    LEGACY_CLIP: LEGACY_CLIP,
    splitSpeakText: splitSpeakText,
    createSession: createSession,
    createWavPump: createWavPump,
    audibleTimeline: audibleTimeline,
    legacyVersusStream: legacyVersusStream,
    legacyClip: function (text) { return String(text || "").slice(0, LEGACY_CLIP); }
  };
})(typeof window !== "undefined" ? window : globalThis);
