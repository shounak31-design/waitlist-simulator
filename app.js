// -------------------- RNG (seeded) --------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6D2B79F5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Poisson sampler (Knuth)
function poisson(lambda, rand) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

// -------------------- Simulation --------------------
function simulate(params) {
  const {
    arrivalRate, capacityPerDay, dnaRate, rebookRate, rebookDelay,
    days, warmup, seed
  } = params;

  const rand = mulberry32(seed);

  const futureAdds = new Array(days + rebookDelay + 2).fill(0);
  const queue = [];
  const queueSizes = [];
  const waits = [];

  let totalSlots = 0;
  let usedSlots = 0;

  for (let d = 0; d < days; d++) {
    const arrivals = poisson(arrivalRate, rand) + futureAdds[d];
    for (let i = 0; i < arrivals; i++) queue.push(d);

    const cap = Math.max(0, Math.floor(capacityPerDay));
    totalSlots += cap;

    for (let s = 0; s < cap; s++) {
      if (queue.length === 0) break;

      usedSlots += 1;
      const enteredDay = queue.shift();
      const isDNA = rand() < (dnaRate / 100);

      if (isDNA) {
        const willRebook = rand() < (rebookRate / 100);
        if (willRebook) {
          const returnDay = d + Math.max(0, Math.floor(rebookDelay));
          if (returnDay < futureAdds.length) futureAdds[returnDay] += 1;
        }
      } else {
        const wait = d - enteredDay;
        if (d >= warmup) waits.push(wait);
      }
    }

    queueSizes.push(queue.length);
  }

  const utilisation = totalSlots > 0 ? usedSlots / totalSlots : 0;

  waits.sort((a, b) => a - b);
  const n = waits.length;

  function quantile(q) {
    if (n === 0) return null;
    const idx = Math.floor((n - 1) * q);
    return waits[idx];
  }

  const mean = n ? waits.reduce((a, b) => a + b, 0) / n : null;
  const median = quantile(0.5);
  const p90 = quantile(0.9);

  const within = (t) => (n ? (waits.filter(w => w <= t).length / n) : null);

  return {
    queueSizes,
    waits,
    metrics: {
      utilisation,
      meanWait: mean,
      medianWait: median,
      p90Wait: p90,
      within14: within(14),
      within28: within(28),
      within42: within(42),
      nSeen: n
    }
  };
}

// -------------------- Formatting --------------------
let queueChart, waitChart;
let lastComparisonRows = null;

function fmtPct(x) {
  if (x === null || Number.isNaN(x)) return "—";
  return (x * 100).toFixed(1) + "%";
}
function fmtNum(x, dp = 1) {
  if (x === null || Number.isNaN(x)) return "—";
  return x.toFixed(dp);
}
function fmtGBP(x) {
  if (x === null || Number.isNaN(x)) return "—";
  return "£" + Math.round(x).toLocaleString();
}

// -------------------- UI Rendering --------------------
function renderMetrics(m) {
  const el = document.getElementById("metrics");
  el.innerHTML = "";

  const items = [
    ["Utilisation", fmtPct(m.utilisation)],
    ["Mean wait (days)", fmtNum(m.meanWait)],
    ["Median wait (days)", fmtNum(m.medianWait, 0)],
    ["P90 wait (days)", fmtNum(m.p90Wait, 0)],
    ["Seen ≤ 2 weeks", fmtPct(m.within14)],
    ["Seen ≤ 4 weeks", fmtPct(m.within28)],
    ["Seen ≤ 6 weeks", fmtPct(m.within42)],
    ["N seen (post warm-up)", String(m.nSeen)]
  ];

  for (const [k, v] of items) {
    const card = document.createElement("div");
    card.className = "metric";
    card.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`;
    el.appendChild(card);
  }
}

function buildHistogram(data, binSize = 3, maxBins = 30) {
  if (!data.length) return { labels: [], counts: [] };
  const max = Math.max(...data);
  const maxEdge = Math.min(max, binSize * maxBins);
  const bins = Math.floor(maxEdge / binSize) + 1;

  const counts = new Array(bins).fill(0);
  for (const x of data) {
    const clamped = Math.min(x, maxEdge);
    const idx = Math.floor(clamped / binSize);
    counts[idx] += 1;
  }

  const labels = counts.map((_, i) => `${i * binSize}-${i * binSize + (binSize - 1)}`);
  return { labels, counts };
}

function renderCharts(out) {
  const qctx = document.getElementById("queueChart").getContext("2d");
  if (queueChart) queueChart.destroy();
  queueChart = new Chart(qctx, {
    type: "line",
    data: {
      labels: out.queueSizes.map((_, i) => i + 1),
      datasets: [{ label: "Queue size", data: out.queueSizes, tension: 0.2 }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true } },
      scales: {
        x: { title: { display: true, text: "Day" } },
        y: { title: { display: true, text: "People waiting" }, beginAtZero: true }
      }
    }
  });

  const hist = buildHistogram(out.waits, 3, 30);
  const wctx = document.getElementById("waitChart").getContext("2d");
  if (waitChart) waitChart.destroy();
  waitChart = new Chart(wctx, {
    type: "bar",
    data: { labels: hist.labels, datasets: [{ label: "Count", data: hist.counts }] },
    options: {
      responsive: true,
      plugins: { legend: { display: true } },
      scales: {
        x: { title: { display: true, text: "Wait time (days, binned)" } },
        y: { title: { display: true, text: "Number of people seen" }, beginAtZero: true }
      }
    }
  });
}

// -------------------- Inputs & Assumptions --------------------
function getParamsFromInputs() {
  return {
    arrivalRate: parseFloat(document.getElementById("arrivalRate").value),
    capacityPerDay: parseInt(document.getElementById("capacityPerDay").value, 10),
    dnaRate: parseFloat(document.getElementById("dnaRate").value),
    rebookRate: parseFloat(document.getElementById("rebookRate").value),
    rebookDelay: parseInt(document.getElementById("rebookDelay").value, 10),
    days: parseInt(document.getElementById("days").value, 10),
    warmup: parseInt(document.getElementById("warmup").value, 10),
    seed: parseInt(document.getElementById("seed").value, 10)
  };
}

function getCostAssumptions() {
  const wteCostAnnual = parseFloat(document.getElementById("wteCostAnnual").value);
  const slotsPerWTE = parseFloat(document.getElementById("slotsPerWTE").value);
  return {
    wteCostAnnual: Number.isFinite(wteCostAnnual) ? wteCostAnnual : 55000,
    slotsPerWTE: Number.isFinite(slotsPerWTE) ? slotsPerWTE : 2
  };
}

function renderAssumptionsPanel() {
  const el = document.getElementById("assumptionsPanel");
  if (!el) return;

  const p = getParamsFromInputs();
  const c = getCostAssumptions();

  const netDelta = p.capacityPerDay - p.arrivalRate;
  const utilisationHint =
    p.capacityPerDay > 0
      ? (p.arrivalRate / p.capacityPerDay)
      : null;

  el.innerHTML = `
    <div class="assumptions-grid">
      <div class="assumption"><div class="k">Arrival rate</div><div class="v">${fmtNum(p.arrivalRate)} / day</div></div>
      <div class="assumption"><div class="k">Capacity</div><div class="v">${p.capacityPerDay} slots / day</div></div>
      <div class="assumption"><div class="k">Net flow (cap − demand)</div><div class="v">${fmtNum(netDelta)} / day</div></div>
      <div class="assumption"><div class="k">DNA</div><div class="v">${fmtNum(p.dnaRate, 0)}%</div></div>
      <div class="assumption"><div class="k">Rebook rate</div><div class="v">${fmtNum(p.rebookRate, 0)}%</div></div>
      <div class="assumption"><div class="k">Rebook delay</div><div class="v">${p.rebookDelay} days</div></div>
      <div class="assumption"><div class="k">Horizon</div><div class="v">${p.days} days</div></div>
      <div class="assumption"><div class="k">Warm-up</div><div class="v">${p.warmup} days</div></div>
      <div class="assumption"><div class="k">Seed</div><div class="v">${p.seed}</div></div>
      <div class="assumption"><div class="k">Cost per WTE</div><div class="v">${fmtGBP(c.wteCostAnnual)} / year</div></div>
      <div class="assumption"><div class="k">Slots per WTE</div><div class="v">${Math.max(0, Math.floor(c.slotsPerWTE))} / day</div></div>
      <div class="assumption"><div class="k">Demand/capacity ratio</div><div class="v">${utilisationHint ? fmtPct(Math.min(utilisationHint, 10)) : "—"}</div></div>
    </div>
  `;
}

// -------------------- Core run --------------------
function run() {
  renderAssumptionsPanel();

  const out = simulate(getParamsFromInputs());
  renderMetrics(out.metrics);
  renderCharts(out);

  // Running a single sim clears comparison export state
  lastComparisonRows = null;
  const exportBtn = document.getElementById("exportCsvBtn");
  if (exportBtn) exportBtn.disabled = true;

  const cmp = document.getElementById("scenarioCompare");
  if (cmp) cmp.innerHTML = "";
}

// -------------------- Scenarios & Comparison --------------------
function buildScenariosFromCurrentInputs() {
  const base = getParamsFromInputs();
  const { slotsPerWTE } = getCostAssumptions();

  const wteSlots = Math.max(0, Math.floor(slotsPerWTE || 0));

  return {
    baseline: { name: "Baseline", params: { ...base } },
    addCapacity: { name: "+2 slots/day", params: { ...base, capacityPerDay: base.capacityPerDay + 2 } },
    reduceDNA: { name: "Reduce DNA (−5pp)", params: { ...base, dnaRate: Math.max(0, base.dnaRate - 5) } },
    addWTE: { name: `+1 WTE (+${wteSlots} slots/day)`, params: { ...base, capacityPerDay: base.capacityPerDay + wteSlots } }
  };
}

function applyScenario(scn) {
  for (const [k, v] of Object.entries(scn.params)) {
    const el = document.getElementById(k);
    if (el) el.value = v;
  }
  run();
}

function estimateIncrementalAnnualCost(baselineParams, scenarioParams) {
  const { wteCostAnnual, slotsPerWTE } = getCostAssumptions();
  const deltaSlots = scenarioParams.capacityPerDay - baselineParams.capacityPerDay;

  if (!Number.isFinite(deltaSlots) || deltaSlots <= 0) return 0;
  if (!Number.isFinite(slotsPerWTE) || slotsPerWTE <= 0) return 0;

  const wteAdded = deltaSlots / slotsPerWTE;
  return wteAdded * wteCostAnnual;
}

function renderComparisonTable(rows) {
  const cmp = document.getElementById("scenarioCompare");
  if (!cmp) return;

  const header = `
    <div class="compare-title">Scenario comparison</div>
    <div class="compare-sub">
      “£ / week saved” is illustrative: incremental annual cost inferred from extra slots/day using WTE assumptions,
      divided by reduction in <strong>median wait</strong> (weeks).
    </div>
  `;

  const tableHead = `
    <table class="compare-table">
      <thead>
        <tr>
          <th>Scenario</th>
          <th>Utilisation</th>
          <th>Median wait</th>
          <th>P90 wait</th>
          <th>Seen ≤ 4 weeks</th>
          <th>£ / week saved</th>
        </tr>
      </thead>
      <tbody>
  `;

  const body = rows.map(r => `
    <tr>
      <td>${r.name}</td>
      <td>${fmtPct(r.m.utilisation)}</td>
      <td>${fmtNum(r.m.medianWait, 0)}d</td>
      <td>${fmtNum(r.m.p90Wait, 0)}d</td>
      <td>${fmtPct(r.m.within28)}</td>
      <td>${r.costPerWeekSaved}</td>
    </tr>
  `).join("");

  cmp.innerHTML = header + tableHead + body + `</tbody></table>`;
}

function runAllComparisons() {
  renderAssumptionsPanel();

  const scenarios = buildScenariosFromCurrentInputs();
  const baseline = scenarios.baseline;
  const baselineOut = simulate(baseline.params);
  const baselineMedian = baselineOut.metrics.medianWait; // days

  const rows = Object.values(scenarios).map(s => {
    const out = simulate(s.params);
    const incCost = estimateIncrementalAnnualCost(baseline.params, s.params);

    const weeksSaved =
      (baselineMedian !== null && out.metrics.medianWait !== null)
        ? (baselineMedian - out.metrics.medianWait) / 7
        : null;

    let costPerWeekSaved = "—";
    if (incCost > 0 && weeksSaved && weeksSaved > 0.05) {
      costPerWeekSaved = fmtGBP(incCost / weeksSaved);
    }

    return { name: s.name, m: out.metrics, costPerWeekSaved };
  });

  lastComparisonRows = rows;
  renderComparisonTable(rows);

  const exportBtn = document.getElementById("exportCsvBtn");
  if (exportBtn) exportBtn.disabled = false;
}

// -------------------- CSV Export --------------------
function toCSV(rows) {
  const header = [
    "Scenario",
    "Utilisation",
    "MedianWaitDays",
    "P90WaitDays",
    "SeenWithin4Weeks",
    "CostPerWeekSavedGBP"
  ];

  const lines = [header.join(",")];

  for (const r of rows) {
    const util = (r.m.utilisation ?? "");
    const seen4 = (r.m.within28 ?? "");
    const cost = (r.costPerWeekSaved || "").replace(/[£,]/g, ""); // numeric-ish

    const row = [
      `"${r.name.replace(/"/g, '""')}"`,
      util === "" ? "" : util,
      r.m.medianWait ?? "",
      r.m.p90Wait ?? "",
      seen4 === "" ? "" : seen4,
      cost || ""
    ];

    lines.push(row.join(","));
  }

  return lines.join("\n");
}

function downloadCSV(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

function exportLastComparisonToCSV() {
  if (!lastComparisonRows || !lastComparisonRows.length) return;

  const csv = toCSV(lastComparisonRows);
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadCSV(`waitlist-scenarios-${ts}.csv`, csv);
}

// -------------------- Wiring --------------------
document.getElementById("runBtn").addEventListener("click", run);

document.getElementById("exampleBtn").addEventListener("click", () => {
  const scenarios = buildScenariosFromCurrentInputs();
  const keys = Object.keys(scenarios);
  const pick = scenarios[keys[Math.floor(Math.random() * keys.length)]];
  applyScenario(pick);
});

document.getElementById("scenarioBaseline").addEventListener("click", () => applyScenario(buildScenariosFromCurrentInputs().baseline));
document.getElementById("scenarioAddCapacity").addEventListener("click", () => applyScenario(buildScenariosFromCurrentInputs().addCapacity));
document.getElementById("scenarioReduceDNA").addEventListener("click", () => applyScenario(buildScenariosFromCurrentInputs().reduceDNA));
document.getElementById("scenarioAddWTE").addEventListener("click", () => applyScenario(buildScenariosFromCurrentInputs().addWTE));
document.getElementById("scenarioCompareBtn").addEventListener("click", runAllComparisons);

const exportBtn = document.getElementById("exportCsvBtn");
if (exportBtn) exportBtn.addEventListener("click", exportLastComparisonToCSV);

// Auto-update assumptions when inputs change
[
  "arrivalRate","capacityPerDay","dnaRate","rebookRate","rebookDelay",
  "days","warmup","seed","wteCostAnnual","slotsPerWTE"
].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", renderAssumptionsPanel);
});

// Initial render
renderAssumptionsPanel();
run();
