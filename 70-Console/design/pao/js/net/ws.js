/* PERSONAL AI OS — 网络状态门面（Super-Brain 只读）
   实际连接由 js/data/sb-bridge.js 负责：SSE /api/stream 优先，REST 轮询兜底。
   本文件只保留旧接口形状（state / on / status），方便 3D 与面板订阅。 */
(function (PAO) {
  'use strict';

  var net = {
    get state() {
      var s = PAO.SB ? PAO.SB.state : 'offline';
      return s === 'online' ? 'online' : (s === 'polling' ? 'online' : 'offline');
    },
    lastEventAt: 0,
    reconnects: 0,

    connect: function () { if (PAO.SB) PAO.SB.init(); },

    /* 订阅真实事件：'event' / '*' / 具体 type */
    on: function (event, fn) {
      var key = event.indexOf('srv:') === 0 ? event.slice(4) : event;
      return PAO.bus.on('sb:event', function (p) {
        if (key === '*' || key === 'event' || (p && (p.type === key || p.source === key))) {
          try { fn(p); } catch (e) { console.error('[net]', key, e); }
        }
      });
    },

    status: function () {
      var s = PAO.SB ? PAO.SB.status() : { state: 'offline' };
      return {
        state: net.state,
        rawState: s.state,
        lastEventAt: (PAO.SB && PAO.SB.lastEventAt) || 0,
        lastLoadAt: (PAO.SB && PAO.SB.lastLoadAt) || 0,
        error: (PAO.SB && PAO.SB.error) || ''
      };
    }
  };

  PAO.net = net;
})(window.PAO = window.PAO || {});
