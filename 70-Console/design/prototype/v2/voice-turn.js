/* 操作台 2.8.5 语音轮次。纯逻辑，不持有密钥，不打开麦克风，不访问网络。
   音频/文本流向（由页面执行，这里只决定允不允许）：
   麦克风 → 本机 Web Audio → 已鉴权的 /api/owner/stt 或 /api/owner/voice/partial
   → 127.0.0.1 上的 Moonshine。页面不打开 Nova-3。
   文字直聊仍走原来的 /api/owner/act。语音定稿的普通闲聊不走 act("msg")，
   改走官方 deepseek-flash。白名单整句只走 GET /api/server，不发给幕僚长，也不生成 shell。
   朗读：用户打开后，已配置文静仍走已有 /api/owner/voice/speak；
   浏览器语音只有 localService===true 的中文音色才允许。不能确认就不可用，不外传。
   快速回复和幕僚长回复按整段描述，不把全量重绘当成逐字流。 */
(function (root) {
  "use strict";
  var ECHO_RMS = 0.02;
  var ECHO_TAIL_MS = 350;
  var READONLY = [
    { id: "server_health", method: "GET", path: "/api/server",
      re: /^(?:服务器健康|健康状态|系统状态|查看服务器|服务器状态)[。！!？?\s]*$/ }
  ];
  var SENSITIVE = /删除|删掉|重启|关机|下单|买入|卖出|转账|付款|支付|改配置|改设定|改设置|执行命令|运行命令|sudo|\brm\b|\bcurl\b|\bwget\b|\bbash\b|\bsh\b|\beval\b|powershell|drop\s+table/i;

  function classifyText(text) {
    var raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) return { kind: "empty", execute: false, send: false, shell: false };
    if (SENSITIVE.test(raw) || /[|&;`$<>\\\n]/.test(raw) || /^\s*(?:sudo|rm|curl|wget|bash|sh|python|eval)\b/i.test(raw)) {
      return { kind: "sensitive", execute: false, send: false, shell: false, confirm: true, id: null, method: null, path: null };
    }
    for (var i = 0; i < READONLY.length; i++) {
      if (READONLY[i].re.test(raw)) {
        return {
          kind: "readonly", execute: true, send: true, shell: false, confirm: false,
          id: READONLY[i].id, method: READONLY[i].method, path: READONLY[i].path
        };
      }
    }
    return { kind: "chat", execute: false, send: true, shell: false, confirm: false, id: null, method: null, path: null };
  }

  /* 已经进到发送函数时：白名单整句不发给幕僚长。敏感句不会自动进到发送函数。 */
  function chatRoute(text) {
    var decision = classifyText(text);
    if (decision.kind === "readonly" && decision.method === "GET" && decision.path === "/api/server" && decision.id === "server_health") {
      return { kind: "health", chief: false, auto: true, decision: decision };
    }
    if (decision.kind === "sensitive") {
      return { kind: "sensitive", chief: false, auto: false, decision: decision };
    }
    if (decision.kind === "chat") {
      return { kind: "chat", chief: true, auto: true, decision: decision };
    }
    return { kind: "empty", chief: false, auto: false, decision: decision };
  }

  var DELEGATE = /告诉幕僚长|让幕僚长办/;

  /* 只给语音定稿用。文字发送仍看 chatRoute，普通文字 chief 保持 true。 */
  function voiceTurnRoute(text) {
    var route = chatRoute(text);
    if (route.kind === "health") return { channel: "health", chief: false, clientAct: false, mock: false, serverMayPost: false };
    if (route.kind !== "chat" || !route.auto) return { channel: "hold", chief: false, clientAct: false, mock: false, serverMayPost: false };
    if (DELEGATE.test(String(text || ""))) return { channel: "delegate", chief: false, clientAct: false, mock: false, serverMayPost: true, once: true };
    return { channel: "assistant", chief: false, clientAct: false, mock: false, serverMayPost: false };
  }

  function voiceAutoAction(text) {
    var decision = classifyText(text);
    if (decision.kind === "sensitive") {
      return { send: false, execute: false, reason: "confirm", decision: decision };
    }
    if (decision.kind === "readonly") {
      return { send: true, execute: true, reason: "readonly", decision: decision };
    }
    if (decision.kind === "chat") {
      return { send: true, execute: false, reason: "chat", decision: decision };
    }
    return { send: false, execute: false, reason: "empty", decision: decision };
  }

  function describeReply(kind, text) {
    var body = String(text || "");
    if (kind === "partial") {
      return { kind: "partial", streaming: true, official: false, redraw: "in-place", label: "部分转写", text: body };
    }
    if (kind === "final") {
      return { kind: "final", streaming: false, official: false, redraw: "in-place", label: "最终转写", text: body };
    }
    if (kind === "quick") {
      return {
        kind: "quick", streaming: false, official: false, redraw: "append-once",
        label: "快速回复（本地规则或本地小模型，整段到达，不是幕僚长正式回复，也不是逐字流式生成）",
        text: body
      };
    }
    if (kind === "chief") {
      return {
        kind: "chief", streaming: false, official: true, redraw: "append-once",
        label: "幕僚长正式回复（整段到达，不是逐字流）",
        text: body
      };
    }
    if (kind === "health") {
      return {
        kind: "health", streaming: false, official: false, redraw: "replace-result",
        label: "只读健康查询结果（GET /api/server，不是幕僚长正式回复，也不是任务完成）",
        text: body
      };
    }
    return { kind: String(kind || "note"), streaming: false, official: false, redraw: "append-once", label: "", text: body };
  }

  function formatHealth(payload) {
    var data = payload && payload.data ? payload.data : (payload || {});
    var lines = [];
    if (data.mem_available_mb != null && data.mem_total_mb != null) {
      lines.push("内存可用 " + data.mem_available_mb + " MB / 共 " + data.mem_total_mb + " MB");
    }
    if (data.loadavg && data.loadavg.length) lines.push("负载 " + data.loadavg.join(" "));
    if (data.disk_free_gb != null) lines.push("磁盘剩余 " + data.disk_free_gb + " GB");
    if (data.uptime_seconds != null) lines.push("运行 " + data.uptime_seconds + " 秒");
    if (!lines.length) lines.push("接口已返回，但没有可显示的健康字段");
    return describeReply("health", lines.join("\n"));
  }

  function pickLocalVoice(voices) {
    var list = voices || [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v && v.localService === true && /zh/i.test(String(v.lang || ""))) return v;
    }
    return null;
  }

  function createTurn(opts) {
    opts = opts || {};
    var nowFn = opts.now || function () { return 0; };
    var gen = 0;
    var seq = 0;
    var armed = false;
    var capture = false;
    var readAloud = false;
    var speaking = false;
    var echoTailUntil = 0;
    var streams = [];
    var aborters = [];
    var pendingReads = [];
    var audio = [];
    var lastText = "";

    function nowOf(sample) {
      if (sample && sample.now != null) return sample.now;
      return nowFn();
    }
    function stopTracks(list) {
      var n = 0;
      (list || []).forEach(function (track) {
        if (track && typeof track.stop === "function" && !track._sbStopped) {
          track.stop();
          track._sbStopped = true;
          n += 1;
        }
      });
      return n;
    }
    function tracksOf(stream) {
      if (!stream) return [];
      if (typeof stream.getTracks === "function") return stream.getTracks() || [];
      return stream.tracks || [];
    }
    function releaseRecord(rec) {
      if (!rec || rec.stopped) return 0;
      rec.stopped = true;
      return stopTracks(rec.tracks);
    }
    function releaseAll() {
      var n = 0;
      streams.forEach(function (rec) { n += releaseRecord(rec); });
      streams = [];
      capture = false;
      return n;
    }
    function abortOlder() {
      var keep = [];
      aborters.forEach(function (item) {
        if (item.gen !== gen) {
          try { item.abort(); } catch (e) { /* 已结束 */ }
        } else keep.push(item);
      });
      aborters = keep;
    }
    function cancelPending(prev) {
      var n = 0;
      pendingReads.forEach(function (item) {
        if (item.gen === prev && item.state === "pending") {
          item.state = "cancelled";
          n += 1;
        }
      });
      return n;
    }
    function countApplied() {
      var n = 0;
      pendingReads.forEach(function (item) { if (item.state === "applied") n += 1; });
      return n;
    }
    function bump(prevKeeper) {
      var prev = gen;
      gen += 1;
      seq = 0;
      speaking = false;
      var dropped = audio.length;
      audio = [];
      abortOlder();
      var cancelled = cancelPending(prevKeeper == null ? prev : prevKeeper);
      return { previous: prev, generation: gen, audioDropped: dropped, cancelledReads: cancelled, completedKept: countApplied(), rolledBack: false };
    }

    function setArmed(on) {
      if (!on) {
        armed = false;
        var ended = bump(gen);
        ended.tracksStopped = releaseAll();
        ended.armed = false;
        ended.reason = "disarm";
        return ended;
      }
      armed = true;
      return { armed: true, capture: capture, generation: gen, rolledBack: false };
    }
    function setCapture(on) {
      if (!armed && on) return { capture: false, reason: "disarmed", generation: gen };
      capture = !!on;
      return { capture: capture, generation: gen };
    }
    function watchStream(stream) {
      var tracks = tracksOf(stream);
      if (!armed) {
        return { accepted: false, tracksStopped: stopTracks(tracks), generation: gen };
      }
      var rec = { stream: stream, tracks: tracks, stopped: false };
      streams.push(rec);
      capture = true;
      return { accepted: true, tracksStopped: 0, generation: gen };
    }
    function releaseStream(stream) {
      var n = 0;
      var keep = [];
      streams.forEach(function (rec) {
        if (stream && rec.stream !== stream) keep.push(rec);
        else n += releaseRecord(rec);
      });
      streams = keep;
      if (!stream) n += releaseAll();
      if (!streams.length) capture = false;
      return { tracksStopped: n, armed: armed, generation: gen };
    }
    function releaseMic() {
      var n = releaseAll();
      return { armed: armed, tracksStopped: n, generation: gen, capture: false };
    }
    function setReadAloud(on) {
      readAloud = !!on;
      if (!readAloud) {
        speaking = false;
        audio = [];
      }
      return { readAloud: readAloud };
    }
    function ttsPlan(options) {
      options = options || {};
      var allowed = readAloud || options.explicit === true;
      if (!allowed) return { mode: "off", speak: false };
      if (options.deepgramConfigured) {
        return { mode: "server-wenjing", speak: true, model: "flux-wenjing-zh" };
      }
      var local = pickLocalVoice(options.voices);
      if (local) {
        return { mode: "local-speech", speak: true, voiceName: local.name || "", lang: local.lang || "zh-CN" };
      }
      return {
        mode: "unavailable",
        speak: false,
        reason: "未能确认 localService=true 的中文本地音色，也没有可用的已配置文静。不调用浏览器语音，避免文字被送到外部合成。"
      };
    }
    function beginUtterance() {
      if (!armed) return { ok: false, reason: "disarmed", generation: gen };
      var moved = bump(gen);
      capture = true;
      lastText = "";
      return { ok: true, generation: moved.generation, previous: moved.previous, rolledBack: false };
    }
    function beginSend() {
      var moved = bump(gen);
      lastText = "";
      return moved;
    }
    function issueSeq() {
      seq += 1;
      return { generation: gen, seq: seq };
    }
    function noteTranscript(g, incoming, text, kind) {
      if (g !== gen) return { accepted: false, reason: "stale-generation", generation: gen, kind: kind };
      if (incoming !== seq) return { accepted: false, reason: "stale-seq", generation: gen, kind: kind };
      lastText = String(text || "");
      var view = describeReply(kind === "final" ? "final" : "partial", lastText);
      view.accepted = true;
      view.reason = "ok";
      view.generation = gen;
      view.seq = incoming;
      return view;
    }
    function canFinalize(g, incoming) {
      return g === gen && incoming === seq && !!String(lastText || "").trim();
    }
    function isCurrent(g) { return g === gen; }
    function trackAbort(g, abort) {
      if (typeof abort !== "function") return { tracked: false };
      if (g !== gen) {
        try { abort(); } catch (e) { /* 已过期 */ }
        return { tracked: false, reason: "stale-generation" };
      }
      aborters.push({ gen: g, abort: abort });
      return { tracked: true, generation: g };
    }
    function armReadOnly(g, id) {
      if (g !== gen) return { armed: false, reason: "stale-generation", rolledBack: false };
      if (id !== "server_health") return { armed: false, reason: "not-whitelisted", rolledBack: false };
      var item = { gen: g, id: id, state: "pending", rolledBack: false, result: null };
      pendingReads.push(item);
      return { armed: true, generation: g, id: id };
    }
    function settleReadOnly(g, id, result) {
      var item = null;
      for (var i = pendingReads.length - 1; i >= 0; i--) {
        if (pendingReads[i].gen === g && pendingReads[i].id === id) { item = pendingReads[i]; break; }
      }
      if (!item) return { applied: false, reason: "unknown", rolledBack: false, generation: g };
      if (item.state === "applied") return { applied: false, reason: "already-settled", rolledBack: false, generation: g };
      if (item.state === "cancelled" || g !== gen) {
        item.state = "cancelled";
        item.rolledBack = false;
        return { applied: false, reason: "cancelled-before-result", rolledBack: false, generation: g };
      }
      item.state = "applied";
      item.result = result;
      item.rolledBack = false;
      return { applied: true, reason: "completed", rolledBack: false, generation: g, result: result };
    }
    function cancelTurn(reason) {
      armed = false;
      var moved = bump(gen);
      moved.tracksStopped = releaseAll();
      moved.reason = reason || "cancel";
      moved.armed = false;
      return moved;
    }
    function enqueueAudio(g, id) {
      if (!readAloud) return { queued: false, reason: "read-aloud-off" };
      if (g !== gen) return { queued: false, reason: "stale-generation" };
      var item = { gen: g, id: id };
      audio.push(item);
      return { queued: true, generation: g, id: id };
    }
    function takeAudio(g) {
      if (g !== gen) return { item: null, reason: "stale-generation" };
      return { item: audio.shift() || null, reason: audio.length || audio ? "ok" : "empty" };
    }
    function setSpeaking(on, at) {
      if (on && readAloud) {
        speaking = true;
        return { speaking: true };
      }
      speaking = false;
      echoTailUntil = (at == null ? nowFn() : at) + ECHO_TAIL_MS;
      return { speaking: false, echoTailUntil: echoTailUntil };
    }
    function onFrame(sample) {
      var at = nowOf(sample);
      var rms = sample && sample.rms ? sample.rms : 0;
      if (!armed || !capture) return { keep: false, reason: !armed ? "disarmed" : "capture-off", generation: gen };
      if (speaking && rms > ECHO_RMS) {
        var moved = bump(gen);
        echoTailUntil = at + ECHO_TAIL_MS;
        capture = true;
        return {
          keep: false, reason: "barge-in", stopAudio: true, generation: moved.generation,
          echoTailUntil: echoTailUntil, cancelledReads: moved.cancelledReads,
          audioDropped: moved.audioDropped, rolledBack: false
        };
      }
      if (speaking) return { keep: false, reason: "assistant-speaking", generation: gen };
      if (at < echoTailUntil) return { keep: false, reason: "echo-tail", generation: gen };
      return { keep: true, reason: "user", generation: gen };
    }
    function reads() {
      return pendingReads.map(function (item) {
        return { gen: item.gen, id: item.id, state: item.state, rolledBack: !!item.rolledBack };
      });
    }
    function liveTracks() {
      var n = 0;
      streams.forEach(function (rec) {
        if (rec.stopped) return;
        (rec.tracks || []).forEach(function (track) { if (!track._sbStopped) n += 1; });
      });
      return n;
    }

    return {
      setArmed: setArmed,
      armed: function () { return armed; },
      setCapture: setCapture,
      captureOn: function () { return capture; },
      watchStream: watchStream,
      releaseStream: releaseStream,
      releaseMic: releaseMic,
      setReadAloud: setReadAloud,
      readAloud: function () { return readAloud; },
      ttsPlan: ttsPlan,
      beginUtterance: beginUtterance,
      beginSend: beginSend,
      issueSeq: issueSeq,
      noteTranscript: noteTranscript,
      canFinalize: canFinalize,
      isCurrent: isCurrent,
      generation: function () { return gen; },
      trackAbort: trackAbort,
      armReadOnly: armReadOnly,
      settleReadOnly: settleReadOnly,
      cancelTurn: cancelTurn,
      enqueueAudio: enqueueAudio,
      takeAudio: takeAudio,
      setSpeaking: setSpeaking,
      onFrame: onFrame,
      reads: reads,
      liveTracks: liveTracks
    };
  }

  function slotBadgeText(kind) {
    if (kind === "unauthorized") return "未认证";
    if (kind === "configured") return "已配置";
    if (kind === "absent") return "未配置";
    return "读取中";
  }

  /* 同一次 401 只让主人徽标写「未授权」。连接徽标写「未连接」，避免窄屏两枚红标看起来是同一个状态画了两次。 */
  function authPills() {
    return { conn: "未连接", owner: "未授权" };
  }

  root.SBVoiceTurn = {
    VERSION: "2.8.8",
    slotBadgeText: slotBadgeText,
    authPills: authPills,
    ECHO_RMS: ECHO_RMS,
    ECHO_TAIL_MS: ECHO_TAIL_MS,
    READONLY_PATH: "/api/server",
    classifyText: classifyText,
    chatRoute: chatRoute,
    voiceTurnRoute: voiceTurnRoute,
    voiceAutoAction: voiceAutoAction,
    describeReply: describeReply,
    formatHealth: formatHealth,
    pickLocalVoice: pickLocalVoice,
    createTurn: createTurn
  };
})(typeof window !== "undefined" ? window : globalThis);
