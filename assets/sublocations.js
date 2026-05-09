/**
 * Shudukhi CAD — MMMP-SL station sub-locations.
 *
 * Each of the 9 metro stations has the same physical structure:
 *   - 2 clinics: North clinic, South clinic
 *   - 2 platforms (each with 6 ramps): North platform R1-R6, South platform R1-R6
 *   - 2 grounds (concourses): North grounds, South grounds
 *
 * MIN3 (Mina station 3) additionally has:
 *   - Bridge from Jamarat area to its platforms
 *
 * Use: window.CADSubLocations.optionsFor('ARF1') -> array of { value, label, group }
 */
(function() {
  const STATIONS = ['ARF1','ARF2','ARF3','MUZ1','MUZ2','MUZ3','MIN1','MIN2','MIN3'];

  const COMMON_TEMPLATE = [
    { group: 'Clinics',     items: ['North clinic', 'South clinic'] },
    { group: 'Platforms',   items: [
      'North platform · Ramp 1','North platform · Ramp 2','North platform · Ramp 3',
      'North platform · Ramp 4','North platform · Ramp 5','North platform · Ramp 6',
      'South platform · Ramp 1','South platform · Ramp 2','South platform · Ramp 3',
      'South platform · Ramp 4','South platform · Ramp 5','South platform · Ramp 6'
    ]},
    { group: 'Grounds',     items: ['North grounds', 'South grounds'] }
  ];

  // MIN3 special: bridge from Jamarat area
  const MIN3_EXTRA = [
    { group: 'Bridge',      items: ['Bridge from Jamarat → North platform','Bridge from Jamarat → South platform','Bridge approach (Jamarat side)'] }
  ];

  function optionsFor(station) {
    const groups = JSON.parse(JSON.stringify(COMMON_TEMPLATE));
    if (String(station).toUpperCase() === 'MIN3') {
      groups.push.apply(groups, MIN3_EXTRA);
    }
    const out = [];
    groups.forEach(function(g) {
      g.items.forEach(function(item) {
        out.push({ value: item, label: item, group: g.group });
      });
    });
    return out;
  }

  function populateSelect(selectEl, station, includeBlank) {
    if (!selectEl) return;
    const opts = optionsFor(station);
    const blank = includeBlank !== false;
    let html = blank ? '<option value="">Sub-location (optional)</option>' : '';
    let lastGroup = '';
    opts.forEach(function(o) {
      if (o.group !== lastGroup) {
        if (lastGroup) html += '</optgroup>';
        html += '<optgroup label="' + o.group + '">';
        lastGroup = o.group;
      }
      html += '<option value="' + o.value + '">' + o.label + '</option>';
    });
    if (lastGroup) html += '</optgroup>';
    selectEl.innerHTML = html;
  }

  window.CADSubLocations = {
    STATIONS: STATIONS,
    optionsFor: optionsFor,
    populateSelect: populateSelect
  };
})();
