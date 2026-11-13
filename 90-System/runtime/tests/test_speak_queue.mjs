// 朗读排队与「首段可觉播」时钟。不访问网络，不读密钥。
// 用法：node 90-System/runtime/tests/test_speak_queue.mjs
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

const sandbox = {
  console,
  Uint8Array,
  Int16Array,
  Float32Array,
  DataView,
  ArrayBuffer,
  Math,
  Object,
  String,
  Number,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(resolve(root, "70-Console/design/prototype/v2/speak-queue.js"), "utf8"), sandbox);
const Q = sandbox.SBSpeakQueue;

function wavHeader(rate, dataLen) {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, dataLen, true);
  return new Uint8Array(buf);
}

check("上限 4000，旧截断记为 500", Q.SPEAK_TEXT_MAX === 4000 && Q.SPEAK_SLICE_MAX === 800 && Q.LEGACY_CLIP === 500);

const plain = "先念这句。接着第二句。最后第三句。";
check("三句都不丢", Q.splitSpeakText(plain).join("") === plain, Q.splitSpeakText(plain).join("|"));

const ver = Q.splitSpeakText("版本 2.8.4 已上线。下一句！");
check("小数点不切句", ver[0] === "版本 2.8.4 已上线。" && ver[1] === "下一句！", ver.join("|"));

const en = Q.splitSpeakText("Hello. World!");
check("英文句号要切", en[0] === "Hello." && en[1] === "World!", en.join("|"));

const linked = Q.splitSpeakText("看 https://example.com/a 完了。");
check("链接不念出来", linked.join("").indexOf("http") < 0 && linked.join("").indexOf("链接") >= 0, linked.join(""));

const hard = "甲".repeat(900);
const hardParts = Q.splitSpeakText(hard);
check("超长句硬切后仍拼得回来", hardParts.join("") === hard && hardParts[0].length === 800 && hardParts[1].length === 100, hardParts.map((p) => p.length).join(","));

const capped = Q.splitSpeakText("乙".repeat(4500));
check("超过 4000 的尾巴不念，界内不丢", capped.join("").length === 4000 && capped.length === 5, capped.join("").length + "/" + capped.length);

const big = plain + "甲".repeat(600);
check("旧路径只留前 500 字", Q.legacyClip(big).length === 500 && Q.splitSpeakText(big).join("").length === big.length);

const header = wavHeader(24000, 0x7FFFFFF0);
const pump = Q.createWavPump();
const partial = pump.push(header.subarray(0, 20));
check("半截 WAV 头还不能听", partial.samples && partial.samples.length === 0 && !partial.unsupported);
const onlyHeader = pump.push(header.subarray(20));
check("完整头仍不能听，采样率 24000", onlyHeader.samples.length === 0 && onlyHeader.rate === 24000 && !onlyHeader.unsupported);
const odd = pump.push(new Uint8Array([0x00]));
check("落单字节先攒着", odd.samples.length === 0);
const one = pump.push(new Uint8Array([0x01]));
check("凑齐一个采样才可播", one.samples.length === 1 && one.samples[0] === 256, one.samples && one.samples[0]);

const eight = header.slice();
eight[34] = 8;
check("不是 16 位单声道就退回整段", Q.createWavPump().push(eight).unsupported === true);
check("不是 WAV 就退回整段", Q.createWavPump().push(new Uint8Array(64)).unsupported === true);

const pcm = new Uint8Array(960);
const times = Q.legacyVersusStream([
  { t: 15, bytes: header },
  { t: 40, bytes: pcm },
  { t: 520, bytes: pcm },
]);
check("头到达不算可觉播", times.afterMs === 40 && times.beforeMs === 520 && times.savedMs === 480 && times.samples === 960, JSON.stringify(times));
console.log("SPEAK_LATENCY_MODEL " + JSON.stringify({
  beforeMs: times.beforeMs,
  afterMs: times.afterMs,
  savedMs: times.savedMs,
  headerNotAudibleMs: 15,
  legacyClip: Q.LEGACY_CLIP,
  speakMax: Q.SPEAK_TEXT_MAX,
}));

const session = Q.createSession();
const quick = session.begin("先念这句。接着第二句。");
check("快速回复先出第一句", session.next(quick.gen) === "先念这句。");
session.cancel();
check("打断后队列清空", session.next(quick.gen) === null && session.pending(quick.gen).length === 0);
const chief = session.begin("正式回复。第二句。");
check("正式回复整段重新排队", session.next(chief.gen) === "正式回复。" && session.next(chief.gen) === "第二句。" && session.next(chief.gen) === null);

if (fails.length) {
  console.error("FAILED " + fails.length);
  process.exit(1);
}
console.log("ALL PASS");
