/* 模拟流拼装。不访问网络，不持有密钥，不调用朗读供应商。 */
(function (root) {
  "use strict";
  var UI = {
    setTab: { tab: { chat: 1, groups: 1, overview: 1, projects: 1, approvals: 1, feed: 1, more: 1 } },
    go: { target: { approvals: 1, agents: 1, "agents-issue": 1, feed: 1, "feed-event": 1, rollcall: 1, server: 1, chat: 1, projects: 1, groups: 1 } },
    scrollChat: {},
    setVoicePanelCollapsed: { collapsed: { true: 1, false: 1 } },
    stopSpeaking: {},
    stopCapture: {},
    getServerHealth: {}
  };

  function createAssembler() {
    var gen = 0;
    var pending = "";
    var sentences = [];
    var closed = false;
    return {
      begin: function () {
        gen += 1;
        pending = "";
        sentences = [];
        closed = false;
        return gen;
      },
      pushDelta: function (g, text) {
        if (closed || g !== gen) return { accepted: false, reason: "stale", sentences: [] };
        pending += String(text || "");
        return { accepted: true, reason: "ok", pending: pending, sentences: sentences.slice() };
      },
      pushSentence: function (g, text) {
        if (closed || g !== gen) return { accepted: false, reason: "stale" };
        var sentence = String(text || "");
        if (pending && sentence.indexOf(pending) !== 0 && pending.indexOf(sentence) !== 0 && pending !== sentence) {
          return { accepted: false, reason: "mismatch" };
        }
        if (sentence) sentences.push(sentence);
        pending = "";
        return { accepted: true, reason: "ok", sentences: sentences.slice(), mock: true };
      },
      cancel: function () {
        closed = true;
        gen += 1;
        pending = "";
        sentences = [];
        return { stopPlayback: true, stopMic: false, generation: gen };
      },
      generation: function () { return gen; },
      sentences: function () { return sentences.slice(); }
    };
  }

  function createSilentPlayer() {
    var queue = [];
    var stopped = false;
    return {
      enqueue: function (g, current, text) {
        if (stopped || g !== current) return { played: false, reason: "stale", network: false };
        queue.push(String(text || ""));
        return { played: true, network: false, fixture: "silent" };
      },
      stop: function () {
        stopped = true;
        queue = [];
        return { stopPlayback: true, stopMic: false };
      },
      resume: function () { stopped = false; },
      played: function () { return queue.slice(); },
      network: false
    };
  }

  function validateAction(name, args) {
    var spec = UI[name];
    if (!spec) return false;
    args = args || {};
    var keys = Object.keys(args);
    var need = Object.keys(spec);
    if (keys.length !== need.length) return false;
    for (var i = 0; i < need.length; i++) {
      if (keys.indexOf(need[i]) < 0) return false;
      var allowed = spec[need[i]];
      if (allowed && !allowed[String(args[need[i]])]) return false;
    }
    return true;
  }

  function shouldStealPlayback() {
    return false;
  }

  function chiefHint(playing) {
    if (playing) {
      return { speak: false, beep: false, hint: "幕僚长有结果，需要时再读。当前播放不打断。" };
    }
    return { speak: true, beep: true, hint: "" };
  }

  function applyAction(name, args, fns) {
    if (!validateAction(name, args)) return { ok: false, reason: "rejected", mock: true };
    if (!fns || typeof fns[name] !== "function") return { ok: false, reason: "unwired", mock: true };
    fns[name](args || {});
    return { ok: true, mock: true, name: name };
  }

  function parseSse(buffer) {
    var parts = String(buffer || "").split("\n\n");
    var rest = parts.pop();
    var events = [];
    parts.forEach(function (block) {
      var name = "message";
      var data = "";
      block.split("\n").forEach(function (line) {
        if (line.indexOf("event:") === 0) name = line.slice(6).trim();
        else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
      });
      if (!data) return;
      try { events.push({ event: name, data: JSON.parse(data) }); }
      catch (e) { events.push({ event: name, data: null, error: "bad-json" }); }
    });
    return { events: events, rest: rest };
  }

  root.SBAssistantStream = {
    createAssembler: createAssembler,
    createSilentPlayer: createSilentPlayer,
    validateAction: validateAction,
    shouldStealPlayback: shouldStealPlayback,
    chiefHint: chiefHint,
    applyAction: applyAction,
    parseSse: parseSse
  };
})(typeof window !== "undefined" ? window : globalThis);
