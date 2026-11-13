/*
 * Drawpane designs: a small local runtime for the .dc.html artboards in this folder.
 *
 * Every artboard loads `./support.js` first. It was written in the Design Component format
 * (see designs/README.md) for a hosted canvas editor. This file is a dependency-light
 * reimplementation of the parts of that format these artboards use, so each one opens in a
 * normal browser straight from the repo:
 *
 *   <x-dc> template · <helmet> head content · {{dotted.path}} holes in text and attributes
 *   <sc-for list as> · <sc-if value> · <dc-import name …props> (sibling .dc.html files)
 *   <x-import component-from-global-scope="Drawpane.X" …props> (React components from the
 *   design system bundle) · <script type="text/x-dc" data-dc-script> with
 *   `class Component extends DCLogic { renderVals() {…} }` and data-props.
 *
 * Top-level props can be set from the query string, e.g. `Main.dc.html?theme=dark`.
 * Serve the folder over HTTP (child artboards are fetched): `python3 -m http.server`.
 */
(function () {
  'use strict';

  var REACT = 'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js';
  var REACT_DOM = 'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js';

  // This script runs synchronously in <head>, before the design-system bundle, which reads
  // window.React when it loads. Writing the tags here makes them load and run in order.
  if (document.readyState === 'loading') {
    if (!window.React) {
      document.write('<script src="' + REACT + '"><\/script><script src="' + REACT_DOM + '"><\/script>');
    }
    document.write('<style>x-dc{display:none!important}#dc-root{display:contents}</style>');
  }

  var HOLE = /\{\{\s*([^}]*?)\s*\}\}/g;
  var WHOLE_HOLE = /^\s*\{\{\s*([^}]*?)\s*\}\}\s*$/;
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var BOOL = { checked: 'defaultChecked', disabled: 'disabled', selected: 'selected', readonly: 'readOnly', multiple: 'multiple',
    hidden: 'hidden', open: 'open', required: 'required', autofocus: 'autoFocus', novalidate: 'noValidate', inert: 'inert' };
  var PROP = { 'class': 'className', 'for': 'htmlFor', tabindex: 'tabIndex', maxlength: 'maxLength', minlength: 'minLength',
    colspan: 'colSpan', rowspan: 'rowSpan', autocomplete: 'autoComplete', contenteditable: 'contentEditable',
    crossorigin: 'crossOrigin', datetime: 'dateTime', srcset: 'srcSet', inputmode: 'inputMode', enterkeyhint: 'enterKeyHint',
    spellcheck: 'spellCheck', 'accept-charset': 'acceptCharset', 'http-equiv': 'httpEquiv', referrerpolicy: 'referrerPolicy' };
  var EVENTS = {};
  ['Click', 'DoubleClick:dblclick', 'Change', 'Input', 'Submit', 'KeyDown', 'KeyUp', 'Focus', 'Blur', 'MouseEnter', 'MouseLeave',
    'MouseDown', 'MouseUp', 'MouseMove', 'PointerDown', 'PointerUp', 'PointerMove', 'PointerEnter', 'PointerLeave', 'Wheel',
    'Scroll', 'ContextMenu'].forEach(function (e) {
    var parts = e.split(':');
    EVENTS['on' + (parts[1] || parts[0].toLowerCase())] = 'on' + parts[0];
  });

  function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }
  function str(v) { return v == null || v === false ? '' : String(v); }

  // ---- holes -------------------------------------------------------------------------------
  function lookup(expr, frames) {
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (expr === 'undefined' || expr === '') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    if (/^(['"]).*\1$/.test(expr)) return expr.slice(1, -1);
    var parts = expr.split('.');
    var v, found = false;
    for (var i = frames.length - 1; i >= 0; i--) {
      var f = frames[i];
      if (f != null && typeof f === 'object' && parts[0] in f) { v = f[parts[0]]; found = true; break; }
    }
    if (!found) return undefined;
    for (var j = 1; j < parts.length; j++) v = v == null ? undefined : v[parts[j]];
    return v;
  }
  function resolve(raw, frames) {
    if (raw == null) return raw;
    var m = raw.match(WHOLE_HOLE);
    if (m) return lookup(m[1], frames);
    if (raw.indexOf('{{') < 0) return raw;
    return raw.replace(HOLE, function (_, e) { return str(lookup(e, frames)); });
  }

  // ---- inline style text -> React style object ----------------------------------------------
  function parseStyle(css) {
    var out = {};
    if (!css) return out;
    var decls = [], depth = 0, quote = null, start = 0;
    for (var i = 0; i < css.length; i++) {
      var c = css[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ';' && depth === 0) { decls.push(css.slice(start, i)); start = i + 1; }
    }
    decls.push(css.slice(start));
    decls.forEach(function (d) {
      var k = d.indexOf(':');
      if (k < 0) return;
      var name = d.slice(0, k).trim(), value = d.slice(k + 1).trim();
      if (!name) return;
      value = value.replace(/\s*!important\s*$/, '');
      if (name.indexOf('--') === 0) out[name] = value;
      else if (name.indexOf('-ms-') === 0) out[camel(name.slice(1))] = value;
      else if (name[0] === '-') out[camel(name.slice(1)).replace(/^./, function (c) { return c.toUpperCase(); })] = value;
      else out[camel(name)] = value;
    });
    return out;
  }

  // ---- template -> React elements -------------------------------------------------------------
  function renderNodes(nodes, frames, ctx) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var r = renderNode(nodes[i], frames, ctx, i);
      if (r == null) continue;
      if (Array.isArray(r)) out.push.apply(out, r); else out.push(r);
    }
    return out;
  }

  function childrenOf(list) { return list.length === 0 ? undefined : list.length === 1 ? list[0] : list; }

  function renderNode(node, frames, ctx, key) {
    var h = React.createElement;
    if (node.nodeType === 3) return node.data.indexOf('{{') < 0 ? node.data : str(resolve(node.data, frames));
    if (node.nodeType !== 1) return null;
    var tag = node.namespaceURI === 'http://www.w3.org/2000/svg' ? node.localName : node.localName.toLowerCase();

    if (tag === 'helmet' || tag === 'script') return null;

    if (tag === 'sc-for') {
      var list = resolve(node.getAttribute('list'), frames) || [];
      var as = node.getAttribute('as') || 'item';
      var kids = Array.prototype.slice.call(node.childNodes);
      return h(React.Fragment, { key: key }, Array.prototype.map.call(list, function (item, idx) {
        var frame = { $index: idx }; frame[as] = item;
        return h(React.Fragment, { key: idx }, renderNodes(kids, frames.concat([frame]), ctx));
      }));
    }

    if (tag === 'sc-if') {
      if (!resolve(node.getAttribute('value'), frames)) return null;
      return h(React.Fragment, { key: key }, renderNodes(Array.prototype.slice.call(node.childNodes), frames, ctx));
    }

    if (tag === 'dc-import') {
      var props = { key: key, dcName: node.getAttribute('name'), dcBase: ctx.base, dcHint: node.getAttribute('hint-size') };
      var childProps = {};
      Array.prototype.forEach.call(node.attributes, function (a) {
        if (a.name === 'name' || a.name.indexOf('hint-') === 0) return;
        childProps[camel(a.name)] = resolve(a.value, frames);
      });
      props.dcProps = childProps;
      return h(DCImport, props);
    }

    if (tag === 'x-import') {
      var path = node.getAttribute('component-from-global-scope') || '';
      var Comp = path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, window);
      var xp = { key: key }, slotStyle = null;
      Array.prototype.forEach.call(node.attributes, function (a) {
        if (a.name === 'component-from-global-scope') return;
        var v = resolve(a.value, frames);
        if (a.name === 'style') { slotStyle = typeof v === 'string' ? parseStyle(v) : v; return; }
        if (a.name === 'class') { xp.className = v; return; }
        xp[camel(a.name)] = v;
      });
      var xkids = childrenOf(renderNodes(Array.prototype.slice.call(node.childNodes), frames, ctx));
      if (xkids !== undefined) xp.children = xkids;
      var el = Comp ? h(Comp, xp) : h('span', { key: key, style: { outline: '1px dashed red', font: '11px monospace' } }, 'missing ' + path);
      return slotStyle ? h('div', { key: key, style: slotStyle }, el) : el;
    }

    var p = { key: key };
    Array.prototype.forEach.call(node.attributes, function (a) {
      var name = a.name, raw = a.value, v = resolve(raw, frames);
      if (name === 'style') { p.style = typeof v === 'string' ? parseStyle(v) : v; return; }
      if (name.indexOf('on') === 0 && (typeof v === 'function' || EVENTS[name])) {
        if (typeof v === 'function') p[EVENTS[name] || camel(name)] = v;
        return;
      }
      if (BOOL[name]) {
        var on = raw === '' || raw === name || v === true || (v !== false && v != null && v !== 'false' && v !== '');
        var prop = BOOL[name];
        if (prop === 'defaultChecked' && tag !== 'input') prop = 'checked';
        p[prop] = on;
        return;
      }
      if (name === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) { p.defaultValue = str(v); return; }
      p[PROP[name] || name] = typeof v === 'object' && v !== null ? v : str(v);
    });
    if (VOID[tag]) return h(tag, p);
    var kids2 = renderNodes(Array.prototype.slice.call(node.childNodes), frames, ctx);
    if (tag === 'textarea') { if (kids2.length) p.defaultValue = kids2.join(''); return h(tag, p); }
    return h.apply(null, [tag, p].concat(kids2));
  }

  // ---- compiling one .dc.html ------------------------------------------------------------------
  var headSeen = {};
  function hoistHelmet(helmet, base) {
    if (!helmet) return;
    Array.prototype.forEach.call(helmet.children, function (el) {
      var sig = el.outerHTML;
      if (headSeen[sig]) return;
      headSeen[sig] = true;
      var copy = document.createElement(el.localName);
      Array.prototype.forEach.call(el.attributes, function (a) { copy.setAttribute(a.name, a.value); });
      if (copy.localName === 'link' && el.getAttribute('href')) copy.setAttribute('href', new URL(el.getAttribute('href'), base).href);
      copy.textContent = el.textContent;
      document.head.appendChild(copy);
    });
  }

  function compile(xdc, script, base) {
    var helmet = null, tpl = [];
    Array.prototype.forEach.call(xdc.childNodes, function (n) {
      if (n.nodeType === 1 && n.localName === 'helmet') helmet = n; else tpl.push(n);
    });
    hoistHelmet(helmet, base);
    var spec = {};
    try { spec = JSON.parse(script.getAttribute('data-props') || '{}'); } catch (e) { console.warn('data-props', base, e); }
    var ctx = { base: base };
    var Base = function DCLogic(props) { React.Component.call(this, props); };
    Base.prototype = Object.create(React.Component.prototype);
    Base.prototype.constructor = Base;
    Base.prototype.renderVals = function () { return {}; };
    Base.prototype.render = function () {
      var frames = [this.renderVals() || {}];
      var kids = renderNodes(tpl, frames, ctx);
      return React.createElement(React.Fragment, null, kids);
    };
    // The artboard's own logic class is classic JS that extends DCLogic.
    var Component = new Function('DCLogic', 'React', '"use strict";\n' + script.textContent + '\n;return Component;')(Base, React);
    return { Component: Component, spec: spec };
  }

  var defs = {};
  function load(url) {
    if (!defs[url]) {
      defs[url] = fetch(url).then(function (r) {
        if (!r.ok) throw new Error(r.status + ' ' + url);
        return r.text();
      }).then(function (text) {
        var doc = new DOMParser().parseFromString(text, 'text/html');
        var xdc = doc.querySelector('x-dc'), script = doc.querySelector('script[data-dc-script]');
        if (!xdc || !script) throw new Error('Not a .dc.html artboard: ' + url);
        return compile(xdc, script, url);
      });
    }
    return defs[url];
  }

  function hintStyle(hint) {
    var wh = (hint || '').split(',');
    return { width: (wh[0] || '').trim() || 'auto', height: (wh[1] || '').trim() || 'auto', background: 'var(--surface-sunken, #eee)', borderRadius: 8 };
  }

  function DCImport(props) {
    var url = new URL(props.dcName + '.dc.html', props.dcBase).href;
    var st = React.useState(null), def = st[0], setDef = st[1];
    var es = React.useState(null), err = es[0], setErr = es[1];
    React.useEffect(function () {
      var live = true;
      load(url).then(function (d) { if (live) setDef(d); }, function (e) { if (live) setErr(e); });
      return function () { live = false; };
    }, [url]);
    if (err) return React.createElement('div', { style: Object.assign(hintStyle(props.dcHint), { color: 'crimson', font: '12px monospace', padding: 8 }) }, String(err));
    if (!def) return React.createElement('div', { style: hintStyle(props.dcHint) });
    return React.createElement(def.Component, props.dcProps);
  }

  // Built lazily: React is not loaded yet when this file first runs.
  function makeErrorBoundary() {
    function ErrorBoundary(props) { React.Component.call(this, props); this.state = { error: null }; }
    ErrorBoundary.prototype = Object.create(React.Component.prototype);
    ErrorBoundary.prototype.constructor = ErrorBoundary;
    ErrorBoundary.getDerivedStateFromError = function (error) { return { error: error }; };
    ErrorBoundary.prototype.render = function () {
      var e = this.state.error;
      if (e) return React.createElement('pre', { style: { color: 'crimson', padding: 16, whiteSpace: 'pre-wrap' } }, String(e && e.stack || e));
      return this.props.children;
    };
    return ErrorBoundary;
  }

  function queryProps() {
    var out = {};
    new URLSearchParams(location.search).forEach(function (v, k) {
      out[k] = v === 'true' ? true : v === 'false' ? false : v;
    });
    return out;
  }

  function boot() {
    var xdc = document.querySelector('body > x-dc') || document.querySelector('x-dc');
    var script = document.querySelector('script[data-dc-script]');
    if (!xdc || !script || !window.React || !window.ReactDOM) {
      if (!window.React) document.body.insertAdjacentHTML('afterbegin', '<p style="font:14px system-ui;padding:16px">React did not load. This viewer needs network access to cdn.jsdelivr.net.</p>');
      return;
    }
    var ErrorBoundary = makeErrorBoundary();
    var def;
    try { def = compile(xdc, script, location.href); } catch (e) { console.error(e); throw e; }
    defs[location.href.split(/[?#]/)[0]] = Promise.resolve(def);
    var mount = document.createElement('div');
    mount.id = 'dc-root';
    xdc.parentNode.insertBefore(mount, xdc);
    xdc.parentNode.removeChild(xdc);
    ReactDOM.createRoot(mount).render(React.createElement(ErrorBoundary, null, React.createElement(def.Component, queryProps())));
  }

  window.DrawpaneDC = { load: load, parseStyle: parseStyle };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
