/* PERSONAL AI OS — DOM 工具 & 格式化（中文优先） */
(function (PAO) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!props.hasOwnProperty(k)) continue;
        var v = props[k];
        if (v == null) continue;
        if (k === 'className' || k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'attrs' && typeof v === 'object') {
          for (var a in v) if (v[a] != null) node.setAttribute(a, v[a]);
        }
        else if (k === 'dataset') { for (var d in v) node.dataset[d] = v[d]; }
        else if (k === 'style' && typeof v === 'object') { for (var s in v) node.style[s] = v[s]; }
        else if (k === 'on' && typeof v === 'object') {
          for (var e in v) node.addEventListener(e, v[e]);
        } else node.setAttribute(k, v);
      }
    }
    appendAll(node, children);
    return node;
  }

  function appendAll(node, children) {
    if (children == null) return node;
    if (!Array.isArray(children)) children = [children];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c == null || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
      else if (c.nodeType) node.appendChild(c);
    }
    return node;
  }

  function svg(tag, attrs, children) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k) && attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (children) {
      if (!Array.isArray(children)) children = [children];
      for (var i = 0; i < children.length; i++) if (children[i]) n.appendChild(children[i]);
    }
    return n;
  }

  /* 静态模板：仅用于不含动态数据的结构 */
  function h(strings) {
    var out = '';
    for (var i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i + 1 < arguments.length) out += arguments[i + 1];
    }
    var tpl = document.createElement('template');
    tpl.innerHTML = out.trim();
    return tpl.content;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  var fmt = {
    num: function (n, digits) {
      if (n == null || isNaN(n)) return '—';
      var v = Number(n);
      if (digits != null) return v.toFixed(digits);
      if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
      return v.toLocaleString('zh-CN');
    },
    pct: function (v, digits) { return (Math.round(Number(v) * 1000) / 10).toFixed(digits == null ? 0 : digits) + '%'; },
    pad: function (n) { return n < 10 ? '0' + n : String(n); },
    time: function (iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d)) return String(iso);
      return d.getFullYear() + '-' + fmt.pad(d.getMonth() + 1) + '-' + fmt.pad(d.getDate()) +
        ' ' + fmt.pad(d.getHours()) + ':' + fmt.pad(d.getMinutes());
    },
    date: function (iso) {
      var d = new Date(iso); if (isNaN(d)) return '—';
      return d.getFullYear() + '-' + fmt.pad(d.getMonth() + 1) + '-' + fmt.pad(d.getDate());
    },
    ago: function (iso) {
      if (!iso) return '—';
      var d = new Date(iso); if (isNaN(d)) return '—';
      var s = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
      if (s < 60) return '刚刚';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
      if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
      if (s < 86400 * 365) return Math.floor(s / 2592000) + ' 个月前';
      return Math.floor(s / 31536000) + ' 年前';
    },
    ms: function (n) { return fmt.num(n) + ' 毫秒'; }
  };

  var ICONS = {
    home: 'M3 10.6 12 3l9 7.6V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    memory: 'M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1 0 8v1a4 4 0 0 1-8 0v-1a4 4 0 0 1 0-8V7a4 4 0 0 1 4-4z',
    cognition: 'M12 2a7 7 0 0 0-7 7c0 2 .8 3.6 2 4.8V17a2 2 0 0 0 2 2h1v3M12 2a7 7 0 0 1 7 7c0 2-.8 3.6-2 4.8V17a2 2 0 0 1-2 2h-1v3',
    agent: 'M4 6h16v9H4zM8 19h8M12 15v4M8 10h.01M12 10h.01M16 10h.01',
    data: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v6c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 13v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
    model: 'M12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
    trust: 'M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6z',
    architecture: 'M4 20V9l8-5 8 5v11M4 20h16M9 20v-6h6v6',
    play: 'M7 4l13 8-13 8z',
    pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
    stop: 'M6 6h12v12H6z',
    refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5 21 21',
    close: 'M6 6l12 12M18 6 6 18',
    chevron: 'M9 6l6 6-6 6',
    check: 'M4 12.5 9.5 18 20 6.5',
    warning: 'M12 3l9.5 17H2.5zM12 9v5M12 17h.01',
    lock: 'M6 10h12v10H6zM9 10V7a3 3 0 0 1 6 0v3',
    unlock: 'M6 10h12v10H6zM9 10V7a3 3 0 0 1 5.6-1.5',
    export: 'M12 16V4M8 8l4-4 4 4M4 16v4h16v-4',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    edit: 'M4 20h4l10-10-4-4L4 16zM14 6l4 4',
    fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 7 2.6h.1A1.6 1.6 0 0 0 8.7 1V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 15 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.1a2 2 0 1 1 0 4H21a1.6 1.6 0 0 0-1.5 1z',
    help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8v.5M12 17h.01',
    skip: 'M5 4l10 8-10 8zM19 4v16',
    next: 'M9 6l6 6-6 6',
    prev: 'M15 6l-6 6 6 6',
    shield: 'M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6zM9 12l2 2 4-4',
    route: 'M4 6h6a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h2M17 3l3 3-3 3M14 21l3-3-3-3',
    sync: 'M20 11A8 8 0 0 0 6 6M4 13a8 8 0 0 0 14 5M20 4v4h-4M4 20v-4h4',
    eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    filter: 'M3 5h18l-7 8v6l-4 2v-8z',
    menu: 'M3 7h18M3 12h18M3 17h18',
    mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
    calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    doc: 'M6 3h8l4 4v14H6zM14 3v4h4',
    image: 'M4 5h16v14H4zM4 15l5-4 4 3 3-2 4 3M9 9h.01',
    voice: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
    browser: 'M4 5h16v14H4zM4 9h16M7 7h.01M9.5 7h.01',
    mobile: 'M8 3h8v18H8zM11 18h2',
    desktop: 'M3 5h18v11H3zM9 20h6M12 16v4',
    watch: 'M9 3h6l1 4v10l-1 4H9l-1-4V7z',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'
  };

  function icon(name, size) {
    var d = ICONS[name] || ICONS.help;
    var s = size || 16;
    var n = svg('svg', {
      width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': 1.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', class: 'pao-icon'
    });
    n.appendChild(svg('path', { d: d }));
    return n;
  }

  function badge(text, kind) {
    return el('span', { className: 'pao-badge pao-badge--' + (kind || 'muted'), text: text });
  }

  function bar(value, kind) {
    var v = Math.max(0, Math.min(1, Number(value) || 0));
    var wrap = el('div', { className: 'pao-bar' + (kind ? ' pao-bar--' + kind : '') });
    var fill = el('i', { className: 'pao-bar__fill' });
    fill.style.transform = 'scaleX(' + v + ')';
    wrap.appendChild(fill);
    return wrap;
  }

  function spark(points, opts) {
    opts = opts || {};
    var w = opts.width || 120, ht = opts.height || 30;
    var max = Math.max.apply(null, points), min = Math.min.apply(null, points);
    var span = (max - min) || 1;
    var d = '';
    for (var i = 0; i < points.length; i++) {
      var x = (i / (points.length - 1)) * w;
      var y = ht - ((points[i] - min) / span) * (ht - 4) - 2;
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    var s = svg('svg', { class: 'pao-spark', width: w, height: ht, viewBox: '0 0 ' + w + ' ' + ht, fill: 'none' });
    s.appendChild(svg('path', { d: d, stroke: opts.color || 'var(--cyan)', 'stroke-width': 1.25, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    return s;
  }

  function ring(value, opts) {
    opts = opts || {};
    var size = opts.size || 56, r = (size - 6) / 2, c = 2 * Math.PI * r;
    var v = Math.max(0, Math.min(1, Number(value) || 0));
    var s = svg('svg', { class: 'pao-ring', width: size, height: size, viewBox: '0 0 ' + size + ' ' + size });
    s.appendChild(svg('circle', { cx: size / 2, cy: size / 2, r: r, fill: 'none', stroke: 'var(--line)', 'stroke-width': 2 }));
    s.appendChild(svg('circle', {
      cx: size / 2, cy: size / 2, r: r, fill: 'none', stroke: opts.color || 'var(--cyan)', 'stroke-width': 2,
      'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - v), transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
      'stroke-linecap': 'round'
    }));
    return s;
  }

  PAO.dom = { el: el, svg: svg, h: h, clear: clear, appendAll: appendAll, fmt: fmt, icon: icon, badge: badge, bar: bar, spark: spark, ring: ring, ICONS: ICONS };
})(window.PAO = window.PAO || {});
