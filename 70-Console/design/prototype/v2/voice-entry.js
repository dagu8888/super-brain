/* 操作台 2.8.1 进页顺序与语音模式。纯逻辑，不持有密钥。 */
(function (root) {
  "use strict";
  var MODES = [
    { id: "hold", label: "按住说话" },
    { id: "stream", label: "流式（本地小模型）" },
    { id: "live", label: "实时语音 API" }
  ];
  var MODE_KEY = "sb.voice.mode";
  var BGM_KEY = "sb.bgm.on";
  var WELCOME_TEXT = "大古，欢迎回来";
  var VOICE_MODEL = "flux-wenjing-zh";
  var VOICE_NAME = "文静";

  function normalizeMode(v) {
    return v === "stream" || v === "live" ? v : "hold";
  }
  function readMode(storage) {
    try { return normalizeMode(storage.getItem(MODE_KEY)); }
    catch (e) { return "hold"; }
  }
  function writeMode(storage, mode) {
    var m = normalizeMode(mode);
    storage.setItem(MODE_KEY, m);
    return m;
  }
  function bgmWanted(storage) {
    try { return storage.getItem(BGM_KEY) !== "0"; }
    catch (e) { return true; }
  }
  /* welcome: ready | skip | blocked | played。bgm 为是否要放背景音乐。
     有欢迎语时它永远排在背景音乐前面。blocked 表示等用户点一下页面再按同一顺序播。 */
  function entrySteps(opts) {
    opts = opts || {};
    var welcome = opts.welcome;
    var steps = [];
    var playWelcome = welcome === "ready" || welcome === "blocked";
    if (playWelcome) steps.push("welcome");
    if (opts.bgm) steps.push("bgm");
    return { steps: steps, deferred: welcome === "blocked" };
  }

  root.SBVoiceEntry = {
    MODES: MODES,
    MODE_KEY: MODE_KEY,
    BGM_KEY: BGM_KEY,
    WELCOME_TEXT: WELCOME_TEXT,
    VOICE_MODEL: VOICE_MODEL,
    VOICE_NAME: VOICE_NAME,
    normalizeMode: normalizeMode,
    readMode: readMode,
    writeMode: writeMode,
    bgmWanted: bgmWanted,
    entrySteps: entrySteps
  };
})(typeof window !== "undefined" ? window : globalThis);
