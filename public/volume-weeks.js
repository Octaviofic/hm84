(() => {
  'use strict';

  const WEEK_OPTIONS = [5, 8, 12, 16, 24, 52];
  let selectedWeeks = 5;
  let activities = [];

  const runTypes = new Set(['Run', 'TrailRun', 'VirtualRun']);
  const rideTypes = new Set(['Ride', 'VirtualRide', 'EBikeRide', 'MountainBikeRide', 'GravelRide']);
  const swimTypes = new Set(['Swim', 'OpenWaterSwim']);

  function kind(a) {
    const t = a.sport_type || a.type || '';
    if (runTypes.has(t)) return 'run';
    if (rideTypes.has(t)) return 'ride';
    if (swimTypes.has(t)) return 'swim';
    return 'other';
  }

  function activityDate(a) {
    return new Date(a.start_date_local || a.start_date);
  }

  function weekStart(input) {
    const d = new Date(input);
    const day = (d.getDay() + 6) % 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day);
    return d;
  }

  function fmtDate(d) {
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
  }

  function hourValue(seconds) {
    return ((+seconds || 0) / 3600).toFixed(1) + ' h';
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .volume-title{align-items:center!important;flex-wrap:wrap}
      .volume-title-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}
      .volume-range{display:flex;align-items:center;gap:8px;padding:6px 7px 6px 10px;border:1px solid var(--line);background:#ffffff06;border-radius:12px}
      .volume-range label{font-size:10px;color:var(--muted);font-weight:800;white-space:nowrap}
      .volume-range select{appearance:none;-webkit-appearance:none;border:0;outline:0;background:var(--panel2);color:var(--txt);font:inherit;font-size:11px;font-weight:900;border-radius:8px;padding:7px 28px 7px 9px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 12px) 11px,calc(100% - 8px) 11px;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
      .volume-range select:focus-visible{outline:2px solid var(--mint);outline-offset:2px}
      .volume-meta{font-size:9px;color:var(--muted);white-space:nowrap}
      #weeklyBars{overflow-x:auto;overflow-y:hidden;padding-bottom:3px;scrollbar-width:thin}
      #weeklyBars .barcol{flex:1 0 28px}
      #weeklyBars .barcol[data-empty="1"]{opacity:.46}
      #weeklyBars .barcol:hover{filter:brightness(1.14)}
      #weeklyBars .seg{transition:filter .12s,opacity .12s}
      #weeklyBars .seg:hover{filter:brightness(1.25)}
      .legend .volume-legend-value{color:var(--txt);font-weight:800;margin-left:3px}
      @media(max-width:600px){.volume-title-right{width:100%;justify-content:space-between}.volume-range{flex:1;justify-content:space-between}.volume-meta{display:none}}
    `;
    document.head.appendChild(style);
  }

  function ownChartNodes() {
    const oldBars = document.getElementById('weeklyBars');
    const oldDonut = document.getElementById('donut');
    if (!oldBars || !oldDonut) return null;

    const bars = oldBars.cloneNode(false);
    oldBars.replaceWith(bars);

    const donut = oldDonut.cloneNode(true);
    oldDonut.replaceWith(donut);

    return {
      bars,
      donut,
      donutHours: donut.querySelector('#donutHours'),
      donutCaption: donut.querySelector('#donutCaption')
    };
  }

  function installSelector(section) {
    const title = section.querySelector('.title');
    if (!title) return null;
    title.classList.add('volume-title');

    const oldHelp = title.querySelector('p');
    const right = document.createElement('div');
    right.className = 'volume-title-right';

    const control = document.createElement('div');
    control.className = 'volume-range';
    control.innerHTML = '<label for="volumeWeeks">Mostrar</label>';

    const select = document.createElement('select');
    select.id = 'volumeWeeks';
    select.setAttribute('aria-label', 'Número de semanas no gráfico de volume');
    WEEK_OPTIONS.forEach(n => {
      const option = document.createElement('option');
      option.value = String(n);
      option.textContent = `${n} semanas`;
      if (n === selectedWeeks) option.selected = true;
      select.appendChild(option);
    });
    control.appendChild(select);

    const meta = document.createElement('span');
    meta.className = 'volume-meta';
    meta.id = 'volumeMeta';

    if (oldHelp) right.appendChild(oldHelp);
    right.appendChild(control);
    right.appendChild(meta);
    title.appendChild(right);

    return { select, meta };
  }

  function selectedWindow() {
    const currentWeek = weekStart(new Date());
    const start = new Date(currentWeek);
    start.setDate(start.getDate() - (selectedWeeks - 1) * 7);
    const end = new Date(currentWeek);
    end.setDate(end.getDate() + 7);
    return { start, end, currentWeek };
  }

  function periodActivities() {
    const { start, end } = selectedWindow();
    return activities.filter(a => {
      const d = activityDate(a);
      return d >= start && d < end;
    });
  }

  function buildWeeks() {
    const { start } = selectedWindow();
    const weeks = [];
    for (let i = 0; i < selectedWeeks; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i * 7);
      weeks.push({ d, run: 0, ride: 0, swim: 0, other: 0, sessions: 0 });
    }

    const byKey = new Map(weeks.map(w => [weekStart(w.d).toISOString().slice(0, 10), w]));
    for (const a of periodActivities()) {
      const key = weekStart(activityDate(a)).toISOString().slice(0, 10);
      const bucket = byKey.get(key);
      if (!bucket) continue;
      bucket[kind(a)] += +a.moving_time || 0;
      bucket.sessions += 1;
    }
    return weeks;
  }

  function renderBars(nodes) {
    const arr = buildWeeks();
    const maxSeconds = Math.max(1, ...arr.map(x => x.run + x.ride + x.swim + x.other));
    const scale = 190 / maxSeconds;
    nodes.bars.innerHTML = '';

    arr.forEach(x => {
      const total = x.run + x.ride + x.swim + x.other;
      const col = document.createElement('div');
      col.className = 'barcol';
      col.dataset.empty = total ? '0' : '1';
      col.style.minWidth = selectedWeeks >= 24 ? '24px' : selectedWeeks >= 16 ? '30px' : '38px';

      const weekEnd = new Date(x.d);
      weekEnd.setDate(weekEnd.getDate() + 6);
      col.title = `Semana ${fmtDate(x.d)} – ${fmtDate(weekEnd)}\nTotal: ${hourValue(total)}\nCorrida: ${hourValue(x.run)}\nBike: ${hourValue(x.ride)}\nNatação: ${hourValue(x.swim)}\nOutros: ${hourValue(x.other)}\n${x.sessions} sessões`;

      [
        ['other', 'var(--violet)'],
        ['swim', 'var(--swim)'],
        ['ride', 'var(--blue)'],
        ['run', 'var(--mint)']
      ].forEach(([k, color]) => {
        const seg = document.createElement('div');
        seg.className = 'seg';
        seg.style.height = (x[k] * scale) + 'px';
        seg.style.background = color;
        if (x[k] > 0) seg.title = `${hourValue(x[k])}`;
        col.appendChild(seg);
      });

      const label = document.createElement('div');
      label.className = 'barlabel';
      label.textContent = fmtDate(x.d);
      col.appendChild(label);
      nodes.bars.appendChild(col);
    });
  }

  function updateLegend(totals, total) {
    const section = [...document.querySelectorAll('section.section')].find(s => s.querySelector('h2')?.textContent.trim() === 'Volume e distribuição');
    const legend = section?.querySelector('.legend');
    if (!legend) return;
    const vals = [totals.run, totals.ride, totals.swim, totals.other];
    [...legend.querySelectorAll('span')].forEach((span, i) => {
      span.querySelector('.volume-legend-value')?.remove();
      const value = document.createElement('b');
      value.className = 'volume-legend-value';
      const pct = total ? (vals[i] / total * 100).toFixed(0) : '0';
      value.textContent = `${(vals[i] / 3600).toFixed(1)}h · ${pct}%`;
      span.appendChild(value);
    });
  }

  function renderDonut(nodes) {
    const totals = { run: 0, ride: 0, swim: 0, other: 0 };
    periodActivities().forEach(a => { totals[kind(a)] += +a.moving_time || 0; });
    const total = totals.run + totals.ride + totals.swim + totals.other;
    const safe = total || 1;
    const a = totals.run / safe * 360;
    const b = a + totals.ride / safe * 360;
    const c = b + totals.swim / safe * 360;

    nodes.donut.style.background = `conic-gradient(var(--mint) 0deg ${a}deg,var(--blue) ${a}deg ${b}deg,var(--swim) ${b}deg ${c}deg,var(--violet) ${c}deg 360deg)`;
    nodes.donutHours.textContent = (total / 3600).toFixed(1) + 'h';
    nodes.donutCaption.textContent = `${selectedWeeks} semanas`;
    nodes.donut.title = `Total: ${(total / 3600).toFixed(1)} h\nCorrida: ${hourValue(totals.run)}\nBike: ${hourValue(totals.ride)}\nNatação: ${hourValue(totals.swim)}\nOutros: ${hourValue(totals.other)}`;
    updateLegend(totals, total);
  }

  function render(nodes, meta) {
    renderBars(nodes);
    renderDonut(nodes);
    const p = periodActivities();
    const oldest = p.length ? new Date(Math.min(...p.map(a => activityDate(a).getTime()))) : null;
    meta.textContent = oldest ? `${p.length} treinos desde ${fmtDate(oldest)}` : 'sem treinos no período';
  }

  async function refresh(nodes, meta) {
    try {
      const res = await fetch('/api/activities');
      if (!res.ok) return;
      const data = await res.json();
      activities = Array.isArray(data.activities) ? data.activities : [];
      render(nodes, meta);
    } catch (e) {
      console.error('HM84 volume weeks:', e);
    }
  }

  function init() {
    const section = [...document.querySelectorAll('section.section')].find(s => s.querySelector('h2')?.textContent.trim() === 'Volume e distribuição');
    if (!section) return;

    injectStyles();
    const nodes = ownChartNodes();
    const selector = installSelector(section);
    if (!nodes || !selector) return;

    selector.select.addEventListener('change', () => {
      selectedWeeks = Number(selector.select.value) || 5;
      render(nodes, selector.meta);
    });

    document.getElementById('syncBtn')?.addEventListener('click', () => {
      setTimeout(() => refresh(nodes, selector.meta), 2200);
    });

    refresh(nodes, selector.meta);
    setInterval(() => refresh(nodes, selector.meta), 300000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
