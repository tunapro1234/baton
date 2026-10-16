window.BatonView = {
  name: 'baton-brief',
  title: 'Handoff brief',
  render: function (root, sc, el) {
    // A member without a shift never "left": the heading follows the basis the server used.
    const lastDay = sc.basis === 'last_24_hours';
    const heading = lastDay ? 'The last 24 hours' : 'Since you left';
    const h1 = document.querySelector('header h1');
    if (h1) h1.textContent = heading;
    document.title = heading;
    const since = String(sc.since || '').replace('T', ' ').slice(0, 16);
    root.append(el('p', 'sub', (lastDay ? 'From ' : 'Since ') + since));
    const facts = sc.facts || [];
    if (!facts.length) {
      root.append(el('section', 'card', null, [el('p', null, 'Nothing new.')]));
      return;
    }
    root.append(el('section', 'card', null, facts.map(function (f) { return el('div', 'fact', f.text); })));
  },
};
