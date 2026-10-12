window.BatonView = {
  name: 'baton-visit',
  title: 'Visit timeline',
  render: function (root, sc, el) {
    const KIND = { dose: 'Doses', plan_change: 'Plan change', observation: 'Note' };
    root.append(el('p', 'sub', (sc.clinician ? 'For ' + sc.clinician + ', ' : '') + sc.from + ' to ' + sc.to));
    root.append(el('p', 'note', sc.note || 'Dates only. No link is implied.'));
    const byDate = {};
    (sc.rows || []).forEach(function (r) { (byDate[r.date] = byDate[r.date] || []).push(r); });
    Object.keys(byDate).sort().forEach(function (d) {
      const items = byDate[d].map(function (r) {
        return el('div', 'fact', null, [el('div', 'kind', KIND[r.kind] || r.kind), el('div', null, r.text)]);
      });
      root.append(el('section', 'card', null, [el('h2', null, d)].concat(items)));
    });
  },
};
