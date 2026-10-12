window.BatonView = {
  name: 'baton-brief',
  title: 'Since you left',
  render: function (root, sc, el) {
    const since = String(sc.since || '').replace('T', ' ').slice(0, 16);
    root.append(el('p', 'sub', 'Since ' + since));
    const facts = sc.facts || [];
    if (!facts.length) {
      root.append(el('section', 'card', null, [el('p', null, 'Nothing new.')]));
      return;
    }
    root.append(el('section', 'card', null, facts.map(function (f) { return el('div', 'fact', f.text); })));
  },
};
