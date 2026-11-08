/* PERSONAL AI OS — event bus + tiny store */
(function (PAO) {
  'use strict';

  var listeners = Object.create(null);

  var bus = {
    store: {
      mode: 'universe',
      activeModule: null,
      booted: false,
      quality: 'high',
      reducedMotion: false,
      memoryFilter: 'ALL',
      memorySelected: null,
      agentTask: null,
      agentRunning: false,
      guidedActive: false,
      guidedStage: -1,
      archLayer: -1,
      archExploded: false,
      connectedSources: 0
    },

    on: function (event, fn) {
      (listeners[event] || (listeners[event] = [])).push(fn);
      return function off() {
        var arr = listeners[event];
        if (!arr) return;
        var i = arr.indexOf(fn);
        if (i > -1) arr.splice(i, 1);
      };
    },

    once: function (event, fn) {
      var off = bus.on(event, function (p) { off(); fn(p); });
      return off;
    },

    emit: function (event, payload) {
      var arr = listeners[event];
      if (arr) {
        var copy = arr.slice();
        for (var i = 0; i < copy.length; i++) {
          try { copy[i](payload); } catch (err) { console.error('[bus]', event, err); }
        }
      }
      if (event !== 'state' && event !== '*' && event.charAt(0) !== '*') {
        bus.emit('*', { event: event, payload: payload });
      }
    },

    set: function (patch) {
      var changed = [];
      for (var k in patch) {
        if (patch.hasOwnProperty(k) && bus.store[k] !== patch[k]) {
          bus.store[k] = patch[k];
          changed.push(k);
        }
      }
      if (changed.length) bus.emit('state', { changed: changed, store: bus.store });
      return changed;
    }
  };

  PAO.bus = bus;
})(window.PAO = window.PAO || {});
