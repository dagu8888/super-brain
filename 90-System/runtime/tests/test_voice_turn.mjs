// 语音轮次：开关、转写取消、回授、白名单、朗读门闩。不打开麦克风，不访问网络，不读密钥。
// 用法：node 90-System/runtime/tests/test_voice_turn.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fails = [];

function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond || detail == null ? "" : " " + detail));
  if (!cond) fails.push(name);
}

const sandbox = { console, Object, String, Number, Math, Array };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(resolve(root, "70-Console/design/prototype/v2/voice-turn.js"), "utf8"), sandbox);
const T = sandbox.SBVoiceTurn;

function tracks(n) {
  const stopped = [];
  const list = [];
  for (let i = 0; i < n; i++) {
    const track = { id: i, stop() { stopped.push(this.id); this.readyState = "ended"; } };
    list.push(track);
  }
  return { stream: { getTracks: () => list, tracks: list }, stopped, list };
}

check("只读白名单只有 /api/server", T.READONLY_PATH === "/api/server");

const health = T.classifyText("服务器健康");
check("服务器健康是 GET /api/server", health.kind === "readonly" && health.execute && health.method === "GET" && health.path === "/api/server" && health.shell === false, JSON.stringify(health));
check("健康状态同样只读", T.classifyText("系统状态。").id === "server_health" && T.classifyText("查看服务器").path === "/api/server");
check("普通聊天不执行", T.voiceAutoAction("你好").send === true && T.voiceAutoAction("你好").execute === false);
const phrases = ["服务器健康", "健康状态", "系统状态", "查看服务器", "服务器状态"];
check("五句白名单都不发给幕僚长", phrases.every((p) => {
  const route = T.chatRoute(p);
  return route.kind === "health" && route.chief === false && route.auto === true && route.decision.path === "/api/server" && route.decision.method === "GET";
}));
check("带标点的白名单仍只查健康", T.chatRoute("服务器健康。").chief === false && T.chatRoute("系统状态？").kind === "health");
check("普通文字仍发给幕僚长", T.chatRoute("你好").kind === "chat" && T.chatRoute("你好").chief === true && T.chatRoute("今天怎么样").chief === true);
check("普通语音不发给幕僚长", T.voiceTurnRoute("你好").channel === "assistant-mock" && T.voiceTurnRoute("你好").chief === false && T.voiceTurnRoute("你好").clientAct === false && T.voiceTurnRoute("你好").mock === true);
check("语音健康不进幕僚长", T.voiceTurnRoute("服务器健康").channel === "health" && T.voiceTurnRoute("服务器健康").chief === false && T.voiceTurnRoute("服务器健康").mock === false);
check("语音委托不由浏览器 act", T.voiceTurnRoute("告诉幕僚长，整理回执").channel === "delegate" && T.voiceTurnRoute("告诉幕僚长，整理回执").clientAct === false && T.voiceTurnRoute("让幕僚长办一下").serverMayPost === true && T.voiceTurnRoute("让幕僚长办一下").once === true);
check("敏感语音仍不自动发送", T.voiceTurnRoute("删除服务器").channel === "hold" && T.voiceTurnRoute("删除服务器").clientAct === false);
check("敏感句不自动执行也不查健康", T.chatRoute("删除服务器").auto === false && T.chatRoute("删除服务器").chief === false && T.voiceAutoAction("删除服务器").send === false);
const nasty = T.classifyText("服务器健康; rm -rf /");
check("带命令的句子不执行", nasty.execute === false && nasty.shell === false && nasty.kind === "sensitive", JSON.stringify(nasty));
check("替换和反引号不执行", T.classifyText("$(id)").execute === false && T.classifyText("`reboot`").execute === false);
check("删除不会变成只读", T.voiceAutoAction("删除服务器").send === false && T.voiceAutoAction("删除服务器").execute === false && T.voiceAutoAction("删除服务器").reason === "confirm");
check("不是白名单全文就不执行", T.classifyText("请看服务器健康和别的").execute === false && T.classifyText("请看服务器健康和别的").kind === "chat");

const quick = T.describeReply("quick", "收到。");
check("快速回复不是逐字流也不是正式完成", quick.streaming === false && quick.official === false && quick.redraw === "append-once" && quick.label.indexOf("不是逐字流") >= 0 && quick.label.indexOf("不是幕僚长正式回复") >= 0);
const chief = T.describeReply("chief", "正式");
check("幕僚长回复按整段标记", chief.streaming === false && chief.official === true && chief.redraw === "append-once" && chief.label.indexOf("不是逐字流") >= 0);
const partial = T.describeReply("partial", "服务");
check("部分转写是就地更新", partial.streaming === true && partial.redraw === "in-place" && partial.official === false);

const view = T.formatHealth({ ok: true, data: { mem_available_mb: 400, mem_total_mb: 1600, loadavg: [0.2, 0.1, 0.1], disk_free_gb: 12 } });
check("健康结果标明只读且不称任务完成", view.streaming === false && view.official === false && view.label.indexOf("GET /api/server") >= 0 && view.label.indexOf("不是任务完成") >= 0 && view.text.indexOf("400") >= 0 && view.text.indexOf("1600") >= 0);

const off = T.createTurn({ now: () => 0 });
check("朗读默认关", off.ttsPlan({ deepgramConfigured: true, voices: [{ lang: "zh-CN", localService: true, name: "本地" }] }).mode === "off");
off.setReadAloud(true);
check("打开朗读且已配置文静时走服务器音色", off.ttsPlan({ deepgramConfigured: true, voices: [{ lang: "zh-CN", localService: false, name: "远程" }] }).mode === "server-wenjing");
check("localService 不是 true 时不可用", off.ttsPlan({ voices: [{ lang: "zh-CN", localService: false, name: "Google" }] }).mode === "unavailable");
check("没写 localService 时不可用", off.ttsPlan({ voices: [{ lang: "zh-CN", name: "未知" }] }).speak === false);
check("英文本地音色不算中文回退", off.ttsPlan({ voices: [{ lang: "en-US", localService: true, name: "Alex" }] }).mode === "unavailable");
const localPlan = off.ttsPlan({ voices: [{ lang: "zh-CN", localService: true, name: "Ting" }] });
check("确认过的中文本地音色才可回退", localPlan.mode === "local-speech" && localPlan.voiceName === "Ting" && localPlan.speak === true);
check("主动点朗读也不把未确认音色外传", off.ttsPlan({ explicit: true, voices: [{ lang: "zh-CN", localService: false }] }).mode === "unavailable");
off.setReadAloud(false);
check("关掉朗读后不再出声", off.ttsPlan({ explicit: false, deepgramConfigured: true }).speak === false);

const mic = tracks(1);
const turn = T.createTurn({ now: () => 0 });
check("默认不采集", turn.armed() === false && turn.liveTracks() === 0);
const blocked = turn.watchStream(mic.stream);
check("未打开采集时立刻停轨", blocked.accepted === false && mic.stopped.length === 1 && turn.liveTracks() === 0, mic.stopped.join(","));

const mic2 = tracks(2);
turn.setArmed(true);
check("打开采集但不自动占麦", turn.armed() === true && turn.liveTracks() === 0);
const watched = turn.watchStream(mic2.stream);
check("打开后才持有音轨", watched.accepted === true && turn.liveTracks() === 2);
const begun = turn.beginUtterance();
check("新轮开始", begun.ok === true && begun.generation > 0);
const s1 = turn.issueSeq();
const s2 = turn.issueSeq();
const stale = turn.noteTranscript(s1.generation, s1.seq, "旧的半句", "partial");
const fresh = turn.noteTranscript(s2.generation, s2.seq, "服务器健康", "partial");
check("旧序号的部分转写丢弃", stale.accepted === false && (stale.reason === "stale-seq" || stale.reason === "stale-generation"), stale.reason);
check("最新部分转写就地接受", fresh.accepted === true && fresh.streaming === true && fresh.redraw === "in-place" && fresh.text === "服务器健康");
const olderFinal = turn.noteTranscript(s1.generation, s1.seq, "旧最终", "final");
check("旧最终转写不能定稿", olderFinal.accepted === false);
const finalOk = turn.noteTranscript(s2.generation, s2.seq, "服务器健康", "final");
check("同一最新序号可以定稿", finalOk.accepted === true && finalOk.kind === "final" && turn.canFinalize(s2.generation, s2.seq));

const action = T.voiceAutoAction(finalOk.text);
const armedRead = turn.armReadOnly(finalOk.generation, action.decision.id);
check("定稿后的健康查询能挂上当前轮", action.execute === true && armedRead.armed === true);
const ended = turn.cancelTurn("user");
const late = turn.settleReadOnly(finalOk.generation, "server_health", { ok: true, data: { mem_total_mb: 1 } });
check("取消后的旧回调不执行只读", late.applied === false && late.rolledBack === false && late.reason === "cancelled-before-result", late.reason);
check("取消会停掉音轨且不谎称回滚", ended.tracksStopped === 2 && ended.rolledBack === false && mic2.stopped.length === 2 && turn.liveTracks() === 0 && turn.armed() === false, ended.tracksStopped + "/" + mic2.stopped.join(","));

const again = T.createTurn({ now: () => 0 });
again.setArmed(true);
again.setReadAloud(true);
const live = tracks(1);
again.watchStream(live.stream);
const said = again.beginUtterance();
const seq = again.issueSeq();
again.noteTranscript(seq.generation, seq.seq, "系统状态", "final");
again.armReadOnly(said.generation, "server_health");
const done = again.settleReadOnly(said.generation, "server_health", { ok: true, data: { mem_available_mb: 10, mem_total_mb: 20 } });
const after = again.cancelTurn("later");
check("已完成的只读结果保持，取消不回滚", done.applied === true && done.rolledBack === false && after.completedKept === 1 && after.cancelledReads === 0 && after.rolledBack === false);
check("完成后再次结算不会改成回滚", again.settleReadOnly(said.generation, "server_health", { ok: true }).rolledBack === false);
check("非白名单挂不上", again.setArmed(true) && again.armReadOnly(again.generation(), "shell").armed === false);

const play = T.createTurn({ now: () => 0 });
play.setArmed(true);
play.setReadAloud(true);
const round = play.beginUtterance();
check("当前轮可以排队音频", play.enqueueAudio(round.generation, "a").queued === true);
play.beginSend();
check("新轮拿不到旧音频", play.takeAudio(round.generation).item == null);
const round2 = play.beginUtterance();
play.enqueueAudio(round2.generation, "b");
check("当前轮还能取出自己的音频", play.takeAudio(round2.generation).item.id === "b");
play.enqueueAudio(round2.generation, "c");
play.cancelTurn("barge");
check("取消后旧音频不能重播", play.takeAudio(round2.generation).item == null);

let clock = 1000;
const ear = T.createTurn({ now: () => clock });
ear.setArmed(true);
ear.setCapture(true);
const heard = tracks(1);
ear.watchStream(heard.stream);
ear.setReadAloud(true);
ear.setSpeaking(true, clock);
check("助手出声时丢掉麦克风帧", ear.onFrame({ rms: 0.001, now: clock }).reason === "assistant-speaking");
const barge = ear.onFrame({ rms: 0.05, now: clock });
check("打断会停音频并取消未完成只读", barge.stopAudio === true && barge.keep === false && barge.rolledBack === false && barge.reason === "barge-in");
check("回授尾音继续丢", ear.onFrame({ rms: 0.01, now: clock + 100 }).reason === "echo-tail");
check("尾音过后才收下用户声音", ear.onFrame({ rms: 0.01, now: clock + T.ECHO_TAIL_MS + 1 }).keep === true);
const released = ear.releaseMic();
check("松手释放音轨但开关还在", released.tracksStopped === 1 && released.armed === true && ear.liveTracks() === 0 && heard.stopped.length === 1);
const keptGen = ear.issueSeq();
check("松手后的这一轮转写仍有效", ear.noteTranscript(keptGen.generation, keptGen.seq, "只填字", "final").accepted === true);
ear.setArmed(false);
check("关掉采集后帧不再收下", ear.onFrame({ rms: 0.2, now: clock + 5000 }).keep === false);

const pills = T.authPills();
check("未授权只留给主人徽标", pills.owner === "未授权" && pills.conn === "未连接" && pills.conn !== pills.owner);
check("401 不显示成未配置", T.slotBadgeText("unauthorized") === "未认证" && T.slotBadgeText("unauthorized") !== T.slotBadgeText("absent"));
check("读到结果后才区分已配置和未配置", T.slotBadgeText("configured") === "已配置" && T.slotBadgeText("absent") === "未配置" && T.slotBadgeText("pending") === "读取中");

if (fails.length) {
  console.log("FAILED " + fails.length);
  process.exit(1);
}
console.log("ALL PASS");
