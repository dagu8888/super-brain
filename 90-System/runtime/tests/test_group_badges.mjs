// 执行操作台 app.js 里的群聊渲染，确认内部 Agent 不打「你的 agent」。
// 用法：node 90-System/runtime/tests/test_group_badges.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const appPath = resolve(root, "70-Console/design/prototype/v2/app.js");
const fails = [];

function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) fails.push(name);
}

function element() {
  return {
    hidden: false,
    innerHTML: "",
    textContent: "",
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 800,
    firstChild: { nodeValue: "" },
  };
}

function createDocument() {
  const elements = new Map();
  const document = {
    readyState: "loading",
    documentElement: { dataset: {} },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) {
      const matched = /^#([\w-]+)$/.exec(String(sel || ""));
      if (!matched) return null;
      if (!elements.has(matched[1])) elements.set(matched[1], element());
      return elements.get(matched[1]);
    },
    querySelectorAll() { return []; },
  };
  return { document, elements };
}

function loadApp() {
  const { document } = createDocument();
  let src = readFileSync(appPath, "utf8");
  const marker = "window.SB = { state: S };";
  if (!src.includes(marker)) throw new Error("找不到 window.SB 导出点");
  src = src
    .replace(marker, "window.SB = { state: S, G, rosterBadge, memberBadge, badgeHtml, renderRoster, renderMid, renderHead, renderStream, renderReply, renderAtBox, showInvite };")
    .replace(
      'if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();',
      "/* badge test does not boot the console */",
    );
  const sandbox = {
    console,
    document,
    location: { protocol: "http:", origin: "http://127.0.0.1", hash: "", pathname: "/", search: "" },
    history: { replaceState() {} },
    navigator: { userAgent: "node" },
    localStorage: { getItem() { return null; }, setItem() {} },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: appPath });
  return { sandbox, document };
}

function elementContaining(html, needle, openMark, closeMark) {
  const at = html.indexOf(needle);
  if (at < 0) return "";
  const open = html.lastIndexOf(openMark, at);
  const close = html.indexOf(closeMark, at);
  if (open < 0 || close < 0) return "";
  return html.slice(open, close + closeMark.length);
}

const internal = {
  id: "grok-chief",
  name: "幕僚长",
  kind: "agent",
  sender_badge: "你的 agent",
  roster_label: "在册",
  talk_label: "名册在册，尚未证实收发",
};
const outsider = {
  id: "ext_1",
  name: "外来客",
  kind: "external",
  sender_badge: "外部",
  roster_label: "外部",
  talk_label: "已证实收发",
};
const spareInternal = {
  id: "muse-chief",
  name: "缪斯",
  kind: "agent",
  sender_badge: "你的 agent",
  roster_label: "在册",
  talk_label: "名册在册，尚未证实收发",
};
const spareExternal = {
  id: "ext_2",
  name: "远客",
  kind: "external",
  sender_badge: "你的 agent",
  roster_label: "外部",
  talk_label: "已证实收发",
};

const { sandbox, document } = loadApp();
const ui = sandbox.SB;
check("渲染函数已挂上", typeof ui.rosterBadge === "function" && typeof ui.renderStream === "function");

check("名册外部仍返回外部", ui.rosterBadge({ kind: "external", sender_badge: "你的 agent" }) === "外部");
check("名册内部返回空", ui.rosterBadge(internal) === "" && ui.rosterBadge({ kind: "agent" }) === "");
check("成员主人仍是人", ui.memberBadge({ member_kind: "human", sender_badge: "你的 agent" }) === "人");
check("成员外部仍是外部", ui.memberBadge({ member_kind: "external" }) === "外部");
check("成员内部返回空", ui.memberBadge({ member_kind: "agent", sender_badge: "你的 agent" }) === "");
check("空标签和内部旧标签都不渲染徽章", ui.badgeHtml("") === "" && ui.badgeHtml("   ") === "" && ui.badgeHtml("你的 agent") === "");
check("人和外部徽章有文字", ui.badgeHtml("人").includes(">人<") && ui.badgeHtml("外部").includes(">外部<") && !ui.badgeHtml("外部").includes("></span>"));

ui.G.roster = [internal, outsider, spareInternal, spareExternal];
ui.G.groups = [{
  group_id: "grp_1",
  name: "试验群",
  join_label: "仅限邀请加入",
  agent_count: 2,
  human_count: 1,
  members: [
    { member_id: "dagu-owner", member_kind: "human", display_name: "大古", sender_badge: "人" },
    { member_id: "grok-chief", member_kind: "agent", display_name: "幕僚长", sender_badge: "你的 agent" },
    { member_id: "ext_1", member_kind: "external", display_name: "外来客", sender_badge: "外部" },
  ],
}];
ui.G.current = "grp_1";
ui.G.tab = "contacts";
ui.G.pending = 0;
ui.G.at = true;
ui.G.messages = [
  { msg_id: "m1", sender_role: "human", from_agent: "dagu-owner", sender_badge: "人", sender_name: "大古", text: "主人发言", created_at: 1730000000 },
  { msg_id: "m2", sender_role: "agent", from_agent: "grok-chief", sender_badge: "你的 agent", sender_name: "幕僚长", text: "内部发言", created_at: 1730000001 },
  { msg_id: "m3", sender_role: "agent", from_agent: "muse-chief", sender_name: "缪斯", text: "没有徽章字段", created_at: 1730000002 },
  { msg_id: "m4", sender_role: "external", from_agent: "ext_1", sender_badge: "外部", sender_name: "外来客", text: "外部发言", created_at: 1730000003 },
  { msg_id: "m5", sender_role: "external", from_agent: "ext_2", sender_badge: "你的 agent", sender_name: "错标客", text: "外部却带了旧标签", created_at: 1730000004 },
];
ui.G.reply = "m2";

ui.renderRoster();
ui.renderMid();
ui.renderHead();
ui.renderStream();
ui.renderReply();
ui.renderAtBox();
ui.showInvite();

const roster = document.querySelector("#grp-roster").innerHTML;
const contacts = document.querySelector("#grp-mid").innerHTML;
const head = document.querySelector("#grp-head").innerHTML;
const stream = document.querySelector("#grp-stream").innerHTML;
const reply = document.querySelector("#grp-reply").innerHTML;
const atBox = document.querySelector("#grp-at-box").innerHTML;
const invite = document.querySelector("#grp-overlay").innerHTML;
const rendered = [roster, contacts, head, stream, reply, atBox, invite];

check("渲染结果不再出现你的 agent", rendered.every((html) => !html.includes("你的 agent")));
const emptyBadge = /<span class="(?:badge )?side-badge"[^>]*>\s*<\/span>/;
check("没有空的徽章元素", rendered.every((html) => !emptyBadge.test(html) && !html.includes('data-side="agent"')));

const internalBtn = elementContaining(roster, 'data-grp-who="grok-chief"', "<button", "</button>");
const externalBtn = elementContaining(roster, 'data-grp-who="ext_1"', "<button", "</button>");
check("名册内部直接列出且没有徽章", internalBtn.includes("幕僚长") && !internalBtn.includes("side-badge") && !roster.includes("<h3>你的 agent</h3>"));
check("名册外部排在后面并标外部", roster.indexOf("幕僚长") < roster.indexOf("<h3>外部</h3>") && roster.indexOf("<h3>外部</h3>") < roster.indexOf("外来客") && externalBtn.includes(">外部<"));

const internalRow = elementContaining(contacts, 'data-grp-with="grok-chief"', '<div class="grp-citem"', "</div>");
check("通讯录内部没有标题也没有徽章", internalRow.includes("幕僚长") && !internalRow.includes("side-badge") && !contacts.includes("你的 agent</h3>") && !contacts.includes('grp-block-title">你的'));
check("通讯录外部单独成组", contacts.indexOf("幕僚长") < contacts.indexOf('grp-block-title">外部') && contacts.indexOf('grp-block-title">外部') < contacts.indexOf("外来客"));

const internalMember = elementContaining(head, "幕僚长", "<li", "</li>");
check("成员列表主人是人、内部无徽章、外部是外部", head.includes('data-side="human">人<') && internalMember.includes("幕僚长") && !internalMember.includes("side-badge") && head.includes('data-side="external">外部<'));
check("气泡主人是人", stream.includes('data-side="human">人<'));
const internalBub = elementContaining(stream, "幕僚长", "<li", "</li>");
const plainBub = elementContaining(stream, "缪斯", "<li", "</li>");
const mislabeledBub = elementContaining(stream, "错标客", "<li", "</li>");
check("气泡内部不渲染徽章", internalBub.includes("内部发言") && !internalBub.includes("side-badge") && plainBub.includes("没有徽章字段") && !plainBub.includes("side-badge"));
check("气泡外部仍是外部", stream.includes('data-side="external">外部<') && mislabeledBub.includes(">外部<") && !mislabeledBub.includes("你的 agent"));
check("回复条不显示内部旧标签", reply.includes("内部发言") && !reply.includes("你的 agent") && !reply.includes("side-badge"));
const atInternal = elementContaining(atBox, "幕僚长", "<button", "</button>");
const atExternal = elementContaining(atBox, "外来客", "<button", "</button>");
check("提及列表内部无徽章、外部有徽章", atInternal.includes("@幕僚长") && !atInternal.includes("side-badge") && atExternal.includes(">外部<"));
const inviteInternal = elementContaining(invite, "缪斯", "<label", "</label>");
const inviteExternal = elementContaining(invite, "远客", "<label", "</label>");
check("邀请名单内部无徽章、外部有徽章", inviteInternal.includes("缪斯") && !inviteInternal.includes("side-badge") && inviteExternal.includes(">外部<") && !invite.includes("你的 agent"));

ui.G.roster = [];
ui.renderRoster();
ui.renderMid();
const emptyRoster = document.querySelector("#grp-roster").innerHTML;
const emptyContacts = document.querySelector("#grp-mid").innerHTML;
check("没有内部 Agent 时不写你的 agent", emptyRoster.includes("还没有已接入的 Agent") && !emptyRoster.includes("你的 agent") && !emptyRoster.includes("<h3>外部</h3>"));
check("通讯录全空仍用原来的空状态", emptyContacts.includes("还没有可联络的 Agent"));

ui.G.roster = [outsider];
ui.renderRoster();
const onlyExternal = document.querySelector("#grp-roster").innerHTML;
check("只有外部时内部区仍单独空着", onlyExternal.includes("还没有已接入的 Agent") && onlyExternal.indexOf("还没有已接入的 Agent") < onlyExternal.indexOf("<h3>外部</h3>") && onlyExternal.includes(">外部<") && !onlyExternal.includes("你的 agent"));

if (fails.length) {
  console.error("FAILED " + fails.length + ": " + fails.join(", "));
  process.exit(1);
}
console.log("ALL PASS");
