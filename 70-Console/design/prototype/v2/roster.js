/* 项目卡上的 Agent 名字圈：能一行就一行，否则均匀分行（6 个不会变成 5+1）。 */
(function (root) {
  "use strict";
  var CIRCLE = 68;
  var GAP = 10;
  function columns(count, width, circle, gap) {
    count = count | 0;
    if (count <= 0) return 1;
    circle = circle || CIRCLE;
    gap = gap == null ? GAP : gap;
    width = Number(width) || 0;
    var fit = Math.max(1, Math.floor((width + gap) / (circle + gap)));
    if (fit >= count) return count;
    var rows = Math.ceil(count / fit);
    return Math.ceil(count / rows);
  }
  root.SBRoster = { columns: columns, CIRCLE: CIRCLE, GAP: GAP };
})(typeof window !== "undefined" ? window : globalThis);
