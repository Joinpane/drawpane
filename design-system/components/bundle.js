/* @ds-bundle: {"format":4,"namespace":"Drawpane","components":[{"name":"Icon"},{"name":"Button"},{"name":"IconButton"},{"name":"Kbd"},{"name":"Tooltip"},{"name":"Badge"},{"name":"TextField"},{"name":"NumberField"},{"name":"TokenChip"},{"name":"SegmentedControl"},{"name":"Switch"},{"name":"PropertySection"},{"name":"LayerRow"},{"name":"Menu"},{"name":"CommandBar"},{"name":"SelectionLens"},{"name":"PresenceStack"},{"name":"AgentTag"},{"name":"AgentStep"},{"name":"PromptField"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;
  var ICONS = {"pointer":[["path",{"d":"M3.5 2.5l9.5 4.6-4.1 1.2-1.6 4.2z"}]],"hand":[["path",{"d":"M5.5 8.5V4a1 1 0 0 1 2 0v3.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7.5V4a1 1 0 0 1 2 0v5.5a4 4 0 0 1-4 4h-.6a4 4 0 0 1-3.2-1.6L2.4 9.9a1 1 0 0 1 1.5-1.3l1.6 1.4"}]],"board":[["path",{"d":"M5.5 2v12M10.5 2v12M2 5.5h12M2 10.5h12"}]],"rectangle":[["rect",{"x":"3","y":"3","width":"10","height":"10","rx":"1.5"}]],"ellipse":[["circle",{"cx":"8","cy":"8","r":"5.25"}]],"pen":[["path",{"d":"M8 2.5l4 5.2L8 13.5 4 7.7z"}],["path",{"d":"M8 13.5V9"}],["circle",{"cx":"8","cy":"7.9","r":"1.1"}]],"text":[["path",{"d":"M3.5 4.5V3h9v1.5M8 3v10M6 13h4"}]],"comment":[["path",{"d":"M3 4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.2L4 13.5V11H4a1 1 0 0 1-1-1z"}]],"component":[["path",{"d":"M8 1.8l6.2 6.2L8 14.2 1.8 8z"}],["path",{"d":"M8 5.4L10.6 8 8 10.6 5.4 8z","fill":"currentColor","stroke":"none"}]],"instance":[["path",{"d":"M8 1.8l6.2 6.2L8 14.2 1.8 8z"}]],"group":[["rect",{"x":"2.75","y":"2.75","width":"10.5","height":"10.5","rx":"1.5","stroke-dasharray":"2 2"}]],"image":[["rect",{"x":"2.5","y":"3","width":"11","height":"10","rx":"1.5"}],["path",{"d":"M2.5 11l3.2-3.2 2.8 2.7 1.8-1.8 3.2 3.1"}],["circle",{"cx":"10.5","cy":"6","r":"1"}]],"eye":[["path",{"d":"M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"}],["circle",{"cx":"8","cy":"8","r":"2"}]],"eye-off":[["path",{"d":"M6.3 3.8A6.6 6.6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.2M10.3 11.9A6 6 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a11.3 11.3 0 0 1 2.4-2.8"}],["path",{"d":"M2.5 2.5l11 11"}]],"lock":[["rect",{"x":"3.5","y":"7","width":"9","height":"6.5","rx":"1.5"}],["path",{"d":"M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7"}]],"plus":[["path",{"d":"M8 3v10M3 8h10"}]],"minus":[["path",{"d":"M3 8h10"}]],"search":[["circle",{"cx":"7","cy":"7","r":"4.25"}],["path",{"d":"M10.2 10.2l3.3 3.3"}]],"chevron-down":[["path",{"d":"M4.5 6.25L8 9.75l3.5-3.5"}]],"chevron-right":[["path",{"d":"M6.25 4.5L9.75 8l-3.5 3.5"}]],"layout-row":[["rect",{"x":"2.5","y":"4","width":"4.5","height":"8","rx":"1"}],["rect",{"x":"9","y":"4","width":"4.5","height":"8","rx":"1"}]],"layout-col":[["rect",{"x":"4","y":"2.5","width":"8","height":"4.5","rx":"1"}],["rect",{"x":"4","y":"9","width":"8","height":"4.5","rx":"1"}]],"layout-grid":[["rect",{"x":"2.5","y":"2.5","width":"4.5","height":"4.5","rx":"1"}],["rect",{"x":"9","y":"2.5","width":"4.5","height":"4.5","rx":"1"}],["rect",{"x":"2.5","y":"9","width":"4.5","height":"4.5","rx":"1"}],["rect",{"x":"9","y":"9","width":"4.5","height":"4.5","rx":"1"}]],"branch":[["circle",{"cx":"5","cy":"3.75","r":"1.5"}],["circle",{"cx":"5","cy":"12.25","r":"1.5"}],["circle",{"cx":"11","cy":"5.5","r":"1.5"}],["path",{"d":"M5 5.25v5.5M11 7c0 2.6-6 1.6-6 3.75"}]],"history":[["path",{"d":"M2.6 8a5.4 5.4 0 1 0 1.7-3.9"}],["path",{"d":"M2.5 2.5v2.75h2.75"}],["path",{"d":"M8 5.25V8l2 1.25"}]],"token":[["path",{"d":"M8 2.25l5 2.9v5.7l-5 2.9-5-2.9V5.15z"}],["circle",{"cx":"8","cy":"8","r":"1.6"}]],"xray":[["path",{"d":"M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11"}],["rect",{"x":"5.5","y":"5.5","width":"5","height":"5","rx":"0.75","stroke-dasharray":"1.5 1.5"}]],"play":[["path",{"d":"M5 3.5v9l7.25-4.5z"}]],"export":[["path",{"d":"M8 10V2.75M5.25 5.5L8 2.75l2.75 2.75M3 9.5v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"}]],"more":[["circle",{"cx":"3.5","cy":"8","r":"1.1","fill":"currentColor","stroke":"none"}],["circle",{"cx":"8","cy":"8","r":"1.1","fill":"currentColor","stroke":"none"}],["circle",{"cx":"12.5","cy":"8","r":"1.1","fill":"currentColor","stroke":"none"}]],"check":[["path",{"d":"M3.25 8.5l3 3 6.5-7"}]],"close":[["path",{"d":"M4 4l8 8M12 4l-8 8"}]],"inspector":[["rect",{"x":"2.5","y":"2.5","width":"11","height":"11","rx":"1.5"}],["path",{"d":"M9.5 2.5v11M11 5.5h.5M11 8h.5"}]],"layers":[["path",{"d":"M8 2.5l5.5 3L8 8.5l-5.5-3z"}],["path",{"d":"M2.5 8.25L8 11.25l5.5-3"}],["path",{"d":"M2.5 11L8 14l5.5-3"}]],"warning":[["path",{"d":"M8 2.5l6 10.5H2z"}],["path",{"d":"M8 6.5v3"}],["circle",{"cx":"8","cy":"11.3","r":"0.6","fill":"currentColor","stroke":"none"}]],"agent":[["rect",{"x":"2.75","y":"4","width":"10.5","height":"8.5","rx":"2.5"}],["path",{"d":"M8 4V2.25"}],["circle",{"cx":"6","cy":"8.25","r":"0.9","fill":"currentColor","stroke":"none"}],["circle",{"cx":"10","cy":"8.25","r":"0.9","fill":"currentColor","stroke":"none"}]],"stop":[["rect",{"x":"4","y":"4","width":"8","height":"8","rx":"1.5","fill":"currentColor","stroke":"none"}]],"send":[["path",{"d":"M8 13V3.5M4.25 7.25L8 3.5l3.75 3.75"}]],"code":[["path",{"d":"M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"}]],"key":[["circle",{"cx":"5.5","cy":"10.5","r":"2.75"}],["path",{"d":"M7.5 8.5l5.5-5.5M11 5l1.75 1.75M9.5 6.5l1.25 1.25"}]],"bolt":[["path",{"d":"M9 1.75L3.75 9H8l-1 5.25L12.25 7H8z"}]],"book":[["path",{"d":"M3 3.25A1.25 1.25 0 0 1 4.25 2H13v10.5H4.25A1.25 1.25 0 0 0 3 13.75z"}],["path",{"d":"M3 13.75A1.25 1.25 0 0 0 4.25 15H13"}]],"plug":[["path",{"d":"M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"}]]};

  function cx() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
    return out.join(' ');
  }
  function omit(p, keys) {
    var o = {};
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k) && keys.indexOf(k) < 0) o[k] = p[k];
    return o;
  }

  /* Icon: 16px grid, 1.5 stroke, inherits currentColor */
  function Icon(p) {
    var parts = ICONS[p.name] || [];
    var size = p.size || 16;
    return h('svg', {
      className: cx('dp-icon', p.className), viewBox: '0 0 16 16', width: size, height: size,
      role: p.label ? 'img' : undefined, 'aria-label': p.label, 'aria-hidden': p.label ? undefined : 'true', focusable: 'false'
    }, parts.map(function (el, i) {
      var a = {}; for (var k in el[1]) a[k === 'stroke-dasharray' ? 'strokeDasharray' : k] = el[1][k];
      a.key = i; return h(el[0], a);
    }));
  }

  function Kbd(p) {
    var keys = p.keys || (typeof p.children === 'string' ? p.children.split(' ') : []);
    return h('span', { className: cx('dp-kbd', p.className), 'aria-label': p.label || keys.join(' ') },
      keys.map(function (k, i) { return h('kbd', { key: i }, k); }));
  }

  function Button(p) {
    var rest = omit(p, ['variant', 'size', 'icon', 'shortcut', 'className', 'children']);
    return h('button', Object.assign({ type: 'button' }, rest, {
      className: cx('dp-btn', 'dp-btn--' + (p.variant || 'secondary'), 'dp-btn--' + (p.size || 'md'), p.className)
    }),
      p.icon ? h(Icon, { name: p.icon }) : null,
      p.children,
      p.shortcut ? h('span', { className: 'dp-btn__key' }, p.shortcut) : null);
  }

  function IconButton(p) {
    var rest = omit(p, ['icon', 'label', 'pressed', 'size', 'className', 'shortcut']);
    return h('button', Object.assign({ type: 'button' }, rest, {
      className: cx('dp-iconbtn', p.size === 'md' && 'dp-iconbtn--md', p.className),
      'aria-label': p.label, title: p.shortcut ? p.label + '  ' + p.shortcut : p.label,
      'aria-pressed': p.pressed === undefined ? undefined : String(!!p.pressed)
    }), h(Icon, { name: p.icon }));
  }

  function Tooltip(p) {
    return h('span', { role: 'tooltip', className: cx('dp-tooltip', p.className) },
      p.label, p.shortcut ? h('span', { className: 'dp-tooltip__key' }, p.shortcut) : null);
  }

  function Badge(p) {
    var tone = p.tone || 'neutral';
    var status = { success: 'check', warning: 'warning', danger: 'warning', info: 'branch' };
    return h('span', { className: cx('dp-badge', 'dp-badge--' + tone, p.className) },
      p.icon || status[tone] ? h(Icon, { name: p.icon || status[tone], size: 12 }) : null, p.children);
  }

  var uid = 0;
  function TextField(p) {
    var id = p.id || ('dp-tf-' + (++uid));
    var rest = omit(p, ['label', 'hint', 'error', 'className', 'id']);
    return h('div', { className: cx('dp-tf', p.error && 'dp-tf--error', p.className) },
      p.label ? h('label', { className: 'dp-tf__label', htmlFor: id }, p.label) : null,
      h('input', Object.assign({ id: id, className: 'dp-tf__input', 'aria-invalid': p.error ? 'true' : undefined }, rest)),
      p.error ? h('span', { className: 'dp-tf__msg dp-tf__msg--error' }, h(Icon, { name: 'warning', size: 12 }), p.error)
        : p.hint ? h('span', { className: 'dp-tf__msg' }, p.hint) : null);
  }

  function TokenChip(p) {
    return h('span', { className: cx('dp-token', p.detached && 'dp-token--detached', p.className), title: p.detached ? 'Detached from ' + p.name : p.name },
      p.swatch ? h('span', { className: 'dp-token__swatch', style: { background: p.swatch } })
        : h(Icon, { name: p.detached ? 'warning' : 'token', size: 12 }),
      h('span', { className: 'dp-token__name' }, p.name));
  }

  function NumberField(p) {
    var rest = omit(p, ['label', 'icon', 'unit', 'token', 'swatch', 'className', 'ariaLabel']);
    return h('div', { className: cx('dp-field', p.token && 'dp-field--token', p.className) },
      h('span', { className: 'dp-field__label', title: 'Drag to scrub' }, p.icon ? h(Icon, { name: p.icon, size: 12 }) : p.label),
      p.token ? h(TokenChip, { name: p.token, swatch: p.swatch })
        : h('input', Object.assign({ className: 'dp-field__input', inputMode: 'decimal', 'aria-label': p.ariaLabel || p.label }, rest)),
      p.unit && !p.token ? h('span', { className: 'dp-field__unit' }, p.unit) : null);
  }

  function SegmentedControl(p) {
    return h('div', { role: 'radiogroup', 'aria-label': p.label, className: cx('dp-seg', p.className) },
      (p.options || []).map(function (o) {
        var on = o.value === p.value;
        return h('button', {
          key: o.value, type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-label': o.icon && !o.label ? o.title : undefined,
          title: o.title, onClick: p.onChange ? function () { p.onChange(o.value); } : undefined
        }, o.icon ? h(Icon, { name: o.icon }) : null, o.label || null);
      }));
  }

  function Switch(p) {
    return h('button', {
      type: 'button', role: 'switch', 'aria-checked': String(!!p.checked), className: cx('dp-switch', p.className),
      onClick: p.onChange ? function () { p.onChange(!p.checked); } : undefined, disabled: p.disabled
    }, h('span', { className: 'dp-switch__track', 'aria-hidden': 'true' }, h('span', { className: 'dp-switch__thumb' })),
      p.label ? h('span', { className: 'dp-switch__label' }, p.label) : null);
  }

  function PropertySection(p) {
    return h('section', { className: cx('dp-section', p.className), 'aria-label': p.title },
      h('header', { className: 'dp-section__head' },
        h('h3', { className: 'dp-section__title' }, p.title),
        p.actions ? h('div', { className: 'dp-section__actions' }, p.actions) : null),
      p.children ? h('div', { className: 'dp-section__body' }, p.children) : null);
  }

  var KIND_ICON = { frame: 'board', board: 'board', group: 'group', rect: 'rectangle', ellipse: 'ellipse', text: 'text', path: 'pen', image: 'image', component: 'component', instance: 'instance' };
  function LayerRow(p) {
    var depth = p.depth || 0;
    var comp = p.kind === 'component' || p.kind === 'instance';
    return h('div', {
      role: 'treeitem', 'aria-selected': String(!!p.selected), 'aria-level': depth + 1,
      'aria-expanded': p.hasChildren ? String(!!p.expanded) : undefined,
      className: cx('dp-layer', p.selected && 'is-selected', p.hidden && 'is-hidden', comp && 'is-component', p.className),
      style: { paddingLeft: 4 + depth * 12 }
    },
      h('span', { className: 'dp-layer__caret' }, p.hasChildren ? h(Icon, { name: p.expanded ? 'chevron-down' : 'chevron-right', size: 12 }) : null),
      h('span', { className: 'dp-layer__icon' }, h(Icon, { name: KIND_ICON[p.kind] || 'rectangle' })),
      h('span', { className: 'dp-layer__name' }, p.name),
      p.presence ? h('span', { className: 'dp-layer__presence', style: { background: 'var(--presence-' + p.presence + ')' }, title: 'Selected by a collaborator' }) : null,
      h('span', { className: cx('dp-layer__actions', (p.hidden || p.locked) && 'is-pinned') },
        p.locked ? h(Icon, { name: 'lock', size: 12, label: 'Locked' }) : null,
        h(Icon, { name: p.hidden ? 'eye-off' : 'eye', size: 12, label: p.hidden ? 'Hidden' : 'Visible' })));
  }

  function Menu(p) {
    return h('div', { role: 'menu', 'aria-label': p.label, className: cx('dp-menu', p.className) },
      (p.items || []).map(function (it, i) {
        if (it.separator) return h('div', { key: i, role: 'separator', className: 'dp-menu__sep' });
        if (it.heading) return h('div', { key: i, className: 'dp-menu__heading' }, it.heading);
        return h('div', {
          key: i, role: 'menuitem', tabIndex: -1, 'aria-disabled': it.disabled ? 'true' : undefined,
          className: cx('dp-menu__item', it.active && 'is-active', it.danger && 'is-danger', it.disabled && 'is-disabled')
        },
          h('span', { className: 'dp-menu__icon' }, it.icon ? h(Icon, { name: it.icon }) : it.checked ? h(Icon, { name: 'check' }) : null),
          h('span', { className: 'dp-menu__label' }, it.label),
          it.submenu ? h(Icon, { name: 'chevron-right', size: 12 }) : it.shortcut ? h('span', { className: 'dp-menu__key' }, it.shortcut) : null);
      }));
  }

  function CommandBar(p) {
    return h('div', { className: cx('dp-cmd', p.className), role: 'dialog', 'aria-label': 'Command bar' },
      h('div', { className: 'dp-cmd__input' },
        h(Icon, { name: 'search' }),
        h('input', { 'aria-label': 'Type a command or a property', placeholder: p.placeholder || 'Type a command, layer or property…', defaultValue: p.query, readOnly: p.readOnly }),
        h(Kbd, { keys: ['esc'] })),
      h('div', { className: 'dp-cmd__results', role: 'listbox' },
        (p.groups || []).map(function (g, gi) {
          return h('div', { key: gi, role: 'group', 'aria-label': g.title },
            h('div', { className: 'dp-cmd__group' }, g.title),
            g.items.map(function (it, ii) {
              return h('div', { key: ii, role: 'option', 'aria-selected': String(!!it.active), className: cx('dp-cmd__item', it.active && 'is-active') },
                h('span', { className: cx('dp-cmd__icon', it.kind === 'component' && 'is-component') }, h(Icon, { name: it.icon || 'pointer' })),
                h('span', { className: 'dp-cmd__label' }, it.label,
                  it.from !== undefined ? h('span', { className: 'dp-cmd__change' }, h('s', null, it.from), ' → ', h('b', null, it.to)) : null,
                  it.hint ? h('span', { className: 'dp-cmd__hint' }, it.hint) : null),
                it.shortcut ? h('span', { className: 'dp-cmd__key' }, it.shortcut) : null);
            }));
        })),
      h('div', { className: 'dp-cmd__foot' },
        h('span', null, h(Kbd, { keys: ['↑', '↓'] }), ' move'),
        h('span', null, h(Kbd, { keys: ['↵'] }), ' run'),
        h('span', null, h(Kbd, { keys: ['tab'] }), ' set value'),
        h('span', { className: 'dp-cmd__scope' }, p.scope || '')));
  }

  function SelectionLens(p) {
    return h('div', { className: cx('dp-lens', p.className), role: 'toolbar', 'aria-label': 'Selection Lens' },
      h('span', { className: 'dp-lens__kind' }, h(Icon, { name: p.kindIcon || 'board', size: 12 }), p.kind || 'Board'),
      h('span', { className: 'dp-lens__sep', 'aria-hidden': 'true' }),
      p.children,
      h('span', { className: 'dp-lens__sep', 'aria-hidden': 'true' }),
      h(IconButton, { icon: 'inspector', label: 'Open Inspector', shortcut: '⌘ .' }));
  }

  function PresenceStack(p) {
    var max = p.max || 4, people = p.people || [];
    var shown = people.slice(0, max), extra = people.length - shown.length;
    return h('div', { className: cx('dp-presence', p.className), 'aria-label': people.length + ' people in this file' },
      shown.map(function (person, i) {
        return h('span', { key: i, className: 'dp-avatar', title: person.name + (person.where ? ' · ' + person.where : ''), style: { '--ring': 'var(--presence-' + (person.color || (i % 8) + 1) + ')' } },
          person.initials || person.name.split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2));
      }),
      extra > 0 ? h('span', { className: 'dp-avatar dp-avatar--more' }, '+' + extra) : null);
  }


  /* Agents */
  function AgentTag(p) {
    var status = p.status || 'working';
    var label = { working: 'Working', waiting: 'Waiting for review', idle: 'Idle', stopped: 'Stopped' }[status];
    return h('span', { className: cx('dp-agenttag', 'dp-agenttag--' + status, p.className), title: p.onBehalfOf ? p.name + ', for ' + p.onBehalfOf : p.name },
      h('span', { className: 'dp-agenttag__chip' }, h(Icon, { name: 'agent', size: 12 }), p.name),
      p.hideStatus ? null : h('span', { className: 'dp-agenttag__status' }, h('span', { className: 'dp-agenttag__dot', 'aria-hidden': 'true' }), label),
      p.onBehalfOf ? h('span', { className: 'dp-agenttag__for' }, 'for ' + p.onBehalfOf) : null);
  }

  function AgentStep(p) {
    var st = p.status || 'queued';
    var icon = { done: 'check', failed: 'warning', review: 'branch' }[st];
    return h('div', { className: cx('dp-step', 'dp-step--' + st, p.className), role: 'listitem', 'aria-label': p.label + ', ' + st },
      h('span', { className: 'dp-step__mark', 'aria-hidden': 'true' }, icon ? h(Icon, { name: icon, size: 12 }) : null),
      h('span', { className: 'dp-step__body' },
        h('span', { className: 'dp-step__label' }, p.label),
        p.detail ? h('span', { className: 'dp-step__detail' }, p.detail) : null,
        p.ops ? h('code', { className: 'dp-step__ops' }, p.ops) : null),
      p.meta ? h('span', { className: 'dp-step__meta' }, p.meta) : null);
  }

  function PromptField(p) {
    var chips = p.context || [];
    return h('div', { className: cx('dp-prompt', p.className) },
      chips.length ? h('div', { className: 'dp-prompt__chips' }, chips.map(function (c, i) {
        return h('span', { key: i, className: 'dp-prompt__chip' }, h(Icon, { name: c.icon || 'layers', size: 12 }), c.label || c);
      })) : null,
      h('textarea', { className: 'dp-prompt__input', rows: p.rows || 2, placeholder: p.placeholder || 'Ask the agent, or type / for a skill', defaultValue: p.value, 'aria-label': p.label || 'Message the agent' }),
      h('div', { className: 'dp-prompt__foot' },
        h(IconButton, { icon: 'plus', label: 'Attach a file or link' }),
        h(IconButton, { icon: 'book', label: 'Use a skill', shortcut: '/' }),
        h('span', { className: 'dp-prompt__model' }, p.model || 'Your model'),
        h('span', { style: { flex: 1 } }),
        p.running ? h('button', { type: 'button', className: 'dp-prompt__send dp-prompt__send--stop', 'aria-label': 'Stop the agent' }, h(Icon, { name: 'stop' }))
          : h('button', { type: 'button', className: 'dp-prompt__send', 'aria-label': 'Send' }, h(Icon, { name: 'send' }))));
  }

  var api = { Icon: Icon, Button: Button, IconButton: IconButton, Kbd: Kbd, Tooltip: Tooltip, Badge: Badge, TextField: TextField, NumberField: NumberField, TokenChip: TokenChip, SegmentedControl: SegmentedControl, Switch: Switch, PropertySection: PropertySection, LayerRow: LayerRow, Menu: Menu, CommandBar: CommandBar, SelectionLens: SelectionLens, PresenceStack: PresenceStack, AgentTag: AgentTag, AgentStep: AgentStep, PromptField: PromptField, icons: Object.keys(ICONS) };
  window.Drawpane = Object.assign(window.Drawpane || {}, api);
})();
