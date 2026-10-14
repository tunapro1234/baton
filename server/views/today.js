window.BatonView = {
  name: 'baton-today',
  title: 'Today',
  render: function (root, sc, el) {
    const LABEL = { given: 'Logged', logged_twice: 'Logged twice', not_logged: 'No entry', upcoming: 'Upcoming' };
    const clock = function (iso) { const t = String(iso || '').slice(11, 16); return t.charAt(0) === '0' ? t.slice(1) : t; };
    root.append(el('p', 'sub', sc.date + ', now ' + clock(sc.now)));
    if (sc.consent) root.append(el('p', 'consent', sc.consent));
    const byWindow = {};
    (sc.grid || []).forEach(function (g) { (byWindow[g.windowId] = byWindow[g.windowId] || []).push(g); });
    Object.keys(byWindow).forEach(function (w) {
      const rows = byWindow[w].map(function (g) {
        const who = g.by ? ' by ' + g.by + (g.at ? ' at ' + clock(g.at) : '') : '';
        return el('div', 'row', null, [
          el('div', null, null, [
            el('div', 'med', g.medName || g.medId),
            g.looks ? el('div', 'looks', g.looks) : null,
            el('div', 'entered', (window.BATON_TEXT || {}).enteredByFamily || 'Entered by the family'),
          ]),
          el('span', 'chip ' + g.status, LABEL[g.status] + who),
        ]);
      });
      root.append(el('section', 'card', null, [el('h2', null, byWindow[w][0].windowLabel || w)].concat(rows)));
    });
  },
};
