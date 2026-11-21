// 模拟流的浏览器侧拼装。不访问网络，不打开麦克风，不调用朗读供应商。
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
const sandbox = { console, Object, String, Number, Math, Array, JSON };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(resolve(root, "70-Console/design/prototype/v2/assistant-stream.js"), "utf8"), sandbox);
const S = sandbox.SBAssistantStream;

const asm = S.createAssembler();
const g1 = asm.begin();
asm.pushDelta(g1, "【模拟");
asm.pushDelta(g1, "流】旧句。");
const player = S.createSilentPlayer();
const tracks = [{ stop() { tracks.stopped = (tracks.stopped || 0) + 1; } }];
check("取消停播放队列且默认不关麦", asm.cancel().stopMic === false && player.stop().stopMic === false && !tracks.stopped);
player.resume();
const g2 = asm.begin();
const stale = asm.pushDelta(g1, "不该拼上");
const fresh = asm.pushDelta(g2, "【模拟流】新句。");
check("新一轮丢掉旧增量", stale.accepted === false && fresh.accepted === true && fresh.pending === "【模拟流】新句。" && fresh.pending.indexOf("旧句") < 0);
const sentence = asm.pushSentence(g2, "【模拟流】新句。");
const played = player.enqueue(g2, g2, "【模拟流】新句。");
check("按句进入静音夹具", sentence.accepted === true && sentence.mock === true && played.played === true && played.network === false && played.fixture === "silent" && player.played().join("") === "【模拟流】新句。");
const raw = "event: delta\ndata: {\"mock\":true,\"text\":\"甲\"}\n\nevent: sentence\ndata: {\"mock\":true,\"text\":\"甲。\"}\n\n";
const parsed = S.parseSse(raw);
check("SSE 拆包保留模拟标记", parsed.events.length === 2 && parsed.events[0].data.mock === true && parsed.events[1].data.text === "甲。");
check("界面白名单拒绝任意脚本", S.validateAction("setTab", { tab: "chat" }) && S.validateAction("go", { target: "chat" }) && S.validateAction("scrollChat", {}) && S.validateAction("setVoicePanelCollapsed", { collapsed: true }) && !S.validateAction("eval", {}) && !S.validateAction("setTab", { tab: "chat", js: "1" }));
check("回包不抢当前播放", S.shouldStealPlayback() === false && S.chiefHint(true).speak === false && S.chiefHint(true).beep === false && S.chiefHint(true).hint.indexOf("不打断") >= 0 && S.chiefHint(false).speak === true);
const fns = { setTab(args) { fns.seen = args.tab; } };
check("只调用已登记的界面函数", S.applyAction("setTab", { tab: "groups" }, fns).ok === true && fns.seen === "groups" && S.applyAction("document.querySelector", {}, fns).ok === false);

if (fails.length) {
  console.log("FAILED " + fails.join(", "));
  process.exit(1);
}
console.log("ALL PASS");
