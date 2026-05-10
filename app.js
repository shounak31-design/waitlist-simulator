// =====================================================
//  Waitlist Capacity Simulator — v2
//  Adds: Monte Carlo replications, patient dropout,
//        instability detection, paired-seed comparison,
//        confidence bands on queue trajectory.
// =====================================================

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

// Poisson sampler (Knuth) — fine for small lambda, falls back for large
function poisson(lambda, rand) {
  if (lambda <= 0) return 0;
  if (lambda > 30) {
    // Normal approximation for large lambda to avoid float underflow in Knuth
    const n = lambda + Math.sqrt(lambda) * gaussian(rand);
    return Math.max(0, Math.round(n));
  }
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

// Box-Muller for the Poisson fallback
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// -------------------- Single-run simulation --------------------
function simulateOnce(params) {
  const {
    arrivalRate, capacityPerDay, dnaRate, rebookRate, rebookDelay,
    dropoutRatePerDay,                       // NEW: per-day patient attrition
    days, warmup, seed
  } = params;

  const rand = mulberry32(seed);
  const futureAdds = new Array(days + Math.max(rebookDelay, 0) + 2).fill(0);
  const queue = [];          // entries are the day each person joined the queue
  const queueSizes = [];
  const waits = [];

  let totalSlots = 0;
  let usedSlots = 0;
  let droppedOut = 0;

  for (let d = 0; d < days; d++) {
    // 1. New arrivals (Poisson) + rebooked patients returning today
    const arrivals = poisson(arrivalRate, rand) + futureAdds[d];
    for (let i = 0; i < arrivals; i++) queue.push(d);

    // 2. Patient-side dropout (people leave the queue while waiting)
    //    Applied as independent per-day hazard on each waiting patient.
    if (dropoutRatePerDay > 0 && queue.length > 0) {
      const survived = [];
      for (const enteredDay of queue) {
        if (rand() >= dropoutRatePerDay) survived.push(enteredDay);
        else droppedOut++;
      }
      queue.length = 0;
      for (const e of survived) queue.push(e);
    }

    // 3. Service: serve up to `cap` patients
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
        // DNA-no-rebook: patient leaves the system entirely
      } else {
        const wait = d - enteredDay;
        if (d >= warmup) waits.push(wait);
      }
    }

    queueSizes.push(queue.length);
  }

  return { queueSizes, waits, totalSlots, usedSlots, droppedOut };
}

// -------------------- Monte Carlo wrapper --------------------
function simulate(params, nReps = 1) {
  // Ensure we always run at least once
  const reps = Math.max(1, Math.floor(nReps));
  const allRuns = [];

  for (let r = 0; r < reps; r++) {
    // Each replication uses a deterministic seed offset so the user can
    // still reproduce by setting the base seed.
    const runParams = { ...params, seed: (params.seed + r * 9973) >>> 0 };
    allRuns.push(simulateOnce(runParams));
  }

  // Aggregate queue trajectory: median, p05, p95 across reps
  const D = params.days;
  const queueMedian = new Array(D);
  const queueP05 = new Array(D);
  const queueP95 = new Array(D);

  for (let d = 0; d < D; d++) {
    const sizesAtD = allRuns.map(run => run.queueSizes[d]).sort((a, b) => a - b);
    queueMedian[d] = sizesAtD[Math.floor(sizesAtD.length * 0.5)];
    queueP05[d]    = sizesAtD[Math.floor(sizesAtD.length * 0.05)];
    queueP95[d]    = sizesAtD[Math.floor(sizesAtD.length * 0.95)];
  }

  // Pool waits across all reps for the histogram
  const pooledWaits = [];
  for (const run of allRuns) for (const w of run.waits) pooledWaits.push(w);
  pooledWaits.sort((a, b) => a - b);
  const n = pooledWaits.length;

  // Per-replication summary metrics → then aggregate
  function quantileOf(arr, q) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * q)];
  }
  function meanOf(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  }

  const perRep = allRuns.map(run => {
    const w = [...run.waits].sort((a, b) => a - b);
    const wn = w.length;
    return {
      utilisation: run.totalSlots ? run.usedSlots / run.totalSlots : 0,
      meanWait: wn ? w.reduce((a, b) => a + b, 0) / wn : null,
      medianWait: wn ? w[Math.floor((wn - 1) * 0.5)] : null,
      p90Wait: wn ? w[Math.floor((wn - 1) * 0.9)] : null,
      within14: wn ? w.filter(x => x <= 14).length / wn : null,
      within28: wn ? w.filter(x => x <= 28).length / wn : null,
      within42: wn ? w.filter(x => x <= 42).length / wn : null,
      nSeen: wn,
      droppedOut: run.droppedOut,
      finalQueue: run.queueSizes[run.queueSizes.length - 1]
    };
  });

  // Pull each metric across replications and report median + 5/95 band
  function summarise(key) {
    const xs = perRep.map(r => r[key]).filter(x => x !== null && Number.isFinite(x));
    if (!xs.length) return { median: null, p05: null, p95: null };
    return {
      median: quantileOf(xs, 0.5),
      p05: quantileOf(xs, 0.05),
      p95: quantileOf(xs, 0.95),
      mean: meanOf(xs)
    };
  }

  // Instability detection: queue still growing in last quarter of horizon
  // (median trajectory, not noise-sensitive)
  const tail = queueMedian.slice(Math.floor(D * 0.75));
  const head = queueMedian.slice(Math.floor(D * 0.5), Math.floor(D * 0.75));
  const tailMean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const headMean = head.reduce((a, b) => a + b, 0) / head.length;
  const isUnstable = tailMean > headMean * 1.10; // 10% growth in second half

  return {
    queueMedian, queueP05, queueP95,
    pooledWaits,
    perRep,
    nReps: reps,
    summary: {
      utilisation: summarise("utilisation"),
      meanWait:    summarise("meanWait"),
      medianWait:  summarise("medianWait"),
      p90Wait:     summarise("p90Wait"),
      within14:    summarise("within14"),
      within28:    summarise("within28"),
      within42:    summarise("within42"),
      nSeen:       summarise("nSeen"),
      droppedOut:  summarise("droppedOut"),
      finalQueue:  summarise("finalQueue")
    },
    isUnstable
  };
}

// -------------------- Formatting --------------------
let queueChart, waitChart;
let lastComparisonRows = null;

function fmtPct(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return (x * 100).toFixed(1) + "%";
}
function fmtNum(x, dp = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return x.toFixed(dp);
}
function fmtGBP(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return "£" + Math.round(x).toLocaleString();
}
function fmtBand(s, dp = 1, asPct = false) {
  // s = { median, p05, p95 }
  if (!s || s.median === null) return "—";
  const f = asPct ? fmtPct : (v => fmtNum(v, dp));
  if (s.p05 === null || s.p95 === null) return f(s.median);
  return `${f(s.median)} <span class="band">[${f(s.p05)}–${f(s.p95)}]</span>`;
}

// -------------------- UI Rendering --------------------
function renderMetrics(summary, isUnstable, nReps) {
  const el = document.getElementById("metrics");
  el.innerHTML = "";

  // Instability banner
  const banner = document.getElementById("instabilityBanner");
  if (banner) {
    if (isUnstable) {
      banner.style.display = "block";
      banner.innerHTML = `
        <strong>System unstable:</strong> queue size is still growing in the
        second half of the horizon. Steady-state metrics below are not meaningful;
        wait times will keep rising as long as demand exceeds effective capacity.
      `;
    } else {
      banner.style.display = "none";
    }
  }

  const repLabel = nReps > 1 ? `Median across ${nReps} runs · [5th–95th percentile]` : "Single run";
  const repNote = document.getElementById("repNote");
  if (repNote) repNote.textContent = repLabel;

  const items = [
    ["Utilisation",            fmtBand(summary.utilisation, 1, true)],
    ["Mean wait (days)",       fmtBand(summary.meanWait, 1)],
    ["Median wait (days)",     fmtBand(summary.medianWait, 0)],
    ["P90 wait (days)",        fmtBand(summary.p90Wait, 0)],
    ["Seen ≤ 2 weeks",         fmtBand(summary.within14, 1, true)],
    ["Seen ≤ 4 weeks",         fmtBand(summary.within28, 1, true)],
    ["Seen ≤ 6 weeks",         fmtBand(summary.within42, 1, true)],
    ["N seen per run",         fmtBand(summary.nSeen, 0)]
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
  const accent = "#7aa7ff";
  const accentTransparent = "rgba(122,167,255,0.18)";
  const muted = "rgba(255,255,255,0.65)";
  const grid = "rgba(255,255,255,0.08)";

  // ---- Queue chart with confidence band ----
  const qctx = document.getElementById("queueChart").getContext("2d");
  if (queueChart) queueChart.destroy();

  const labels = out.queueMedian.map((_, i) => i + 1);

  // Trick: draw p95 as a filled area above p05 to make a band
  queueChart = new Chart(qctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "5th percentile",
          data: out.queueP05,
          borderColor: "transparent",
          backgroundColor: accentTransparent,
          pointRadius: 0,
          fill: false
        },
        {
          label: "95th percentile",
          data: out.queueP95,
          borderColor: "transparent",
          backgroundColor: accentTransparent,
          pointRadius: 0,
          fill: "-1"  // fill to previous dataset (p05)
        },
        {
          label: out.nReps > 1 ? "Median queue size" : "Queue size",
          data: out.queueMedian,
          borderColor: accent,
          backgroundColor: accent,
          pointRadius: 0,
          tension: 0.2,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true, labels: { color: muted, filter: (it) => it.text.includes("queue") || it.text.includes("Queue") } }
      },
      scales: {
        x: {
          title: { display: true, text: "Day", color: muted },
          ticks: { color: muted, maxTicksLimit: 12 },
          grid: { color: grid }
        },
        y: {
          title: { display: true, text: "People waiting", color: muted },
          ticks: { color: muted },
          grid: { color: grid },
          beginAtZero: true
        }
      }
    }
  });

  // ---- Wait time histogram ----
  const hist = buildHistogram(out.pooledWaits, 3, 30);
  const wctx = document.getElementById("waitChart").getContext("2d");
  if (waitChart) waitChart.destroy();
  waitChart = new Chart(wctx, {
    type: "bar",
    data: {
      labels: hist.labels,
      datasets: [{
        label: "Patients seen (pooled across runs)",
        data: hist.counts,
        backgroundColor: accentTransparent,
        borderColor: accent,
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true, labels: { color: muted } } },
      scales: {
        x: {
          title: { display: true, text: "Wait time (days, binned)", color: muted },
          ticks: { color: muted },
          grid: { color: grid }
        },
        y: {
          title: { display: true, text: "Number of people seen", color: muted },
          ticks: { color: muted },
          grid: { color: grid },
          beginAtZero: true
        }
      }
    }
  });
}

// -------------------- Inputs & Assumptions --------------------
function getParamsFromInputs() {
  return {
    arrivalRate:        parseFloat(document.getElementById("arrivalRate").value),
    capacityPerDay:     parseInt(document.getElementById("capacityPerDay").value, 10),
    dnaRate:            parseFloat(document.getElementById("dnaRate").value),
    rebookRate:         parseFloat(document.getElementById("rebookRate").value),
    rebookDelay:        parseInt(document.getElementById("rebookDelay").value, 10),
    dropoutRatePerDay:  parseFloat(document.getElementById("dropoutRate").value) / 100,
    days:               parseInt(document.getElementById("days").value, 10),
    warmup:             parseInt(document.getElementById("warmup").value, 10),
    seed:               parseInt(document.getElementById("seed").value, 10),
    nReps:              parseInt(document.getElementById("nReps").value, 10)
  };
}

function getCostAssumptions() {
  const wteCostAnnual = parseFloat(document.getElementById("wteCostAnnual").value);
  const slotsPerWTE = parseFloat(document.getElementById("slotsPerWTE").value); // FIX: was parseInt
  return {
    wteCostAnnual: Number.isFinite(wteCostAnnual) ? wteCostAnnual : 55000,
    slotsPerWTE:   Number.isFinite(slotsPerWTE) ? slotsPerWTE : 2
  };
}

function renderAssumptionsPanel() {
  const el = document.getElementById("assumptionsPanel");
  if (!el) return;

  const p = getParamsFromInputs();
  const c = getCostAssumptions();

  const netDelta = p.capacityPerDay - p.arrivalRate;
  const ratio = p.capacityPerDay > 0 ? (p.arrivalRate / p.capacityPerDay) : null;

  el.innerHTML = `
    <div class="assumptions-grid">
      <div class="assumption"><div class="k">Arrival rate</div><div class="v">${fmtNum(p.arrivalRate)} / day</div></div>
      <div class="assumption"><div class="k">Capacity</div><div class="v">${p.capacityPerDay} slots / day</div></div>
      <div class="assumption"><div class="k">Net flow (cap − demand)</div><div class="v">${fmtNum(netDelta)} / day</div></div>
      <div class="assumption"><div class="k">DNA</div><div class="v">${fmtNum(p.dnaRate, 0)}%</div></div>
      <div class="assumption"><div class="k">Rebook rate</div><div class="v">${fmtNum(p.rebookRate, 0)}%</div></div>
      <div class="assumption"><div class="k">Rebook delay</div><div class="v">${p.rebookDelay} days</div></div>
      <div class="assumption"><div class="k">Patient dropout</div><div class="v">${fmtNum(p.dropoutRatePerDay * 100, 2)}% / day</div></div>
      <div class="assumption"><div class="k">Horizon</div><div class="v">${p.days} days</div></div>
      <div class="assumption"><div class="k">Warm-up</div><div class="v">${p.warmup} days</div></div>
      <div class="assumption"><div class="k">Replications</div><div class="v">${p.nReps}</div></div>
      <div class="assumption"><div class="k">Base seed</div><div class="v">${p.seed}</div></div>
      <div class="assumption"><div class="k">Cost per WTE</div><div class="v">${fmtGBP(c.wteCostAnnual)} / year</div></div>
      <div class="assumption"><div class="k">Slots per WTE</div><div class="v">${fmtNum(c.slotsPerWTE, 1)} / day</div></div>
      <div class="assumption"><div class="k">Demand/capacity ratio</div><div class="v">${ratio ? fmtPct(Math.min(ratio, 10)) : "—"}</div></div>
    </div>
  `;
}

// -------------------- Core run --------------------
function run() {
  renderAssumptionsPanel();

  const params = getParamsFromInputs();
  const out = simulate(params, params.nReps);

  renderMetrics(out.summary, out.isUnstable, out.nReps);
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
  const wteSlots = Math.max(1, Math.round(slotsPerWTE || 0));

  return {
    baseline:    { name: "Baseline",                            params: { ...base } },
    addCapacity: { name: "+2 slots/day",                        params: { ...base, capacityPerDay: base.capacityPerDay + 2 } },
    reduceDNA:   { name: "Reduce DNA (−5pp)",                   params: { ...base, dnaRate: Math.max(0, base.dnaRate - 5) } },
    addWTE:      { name: `+1 WTE (+${wteSlots} slots/day)`,      params: { ...base, capacityPerDay: base.capacityPerDay + wteSlots } }
  };
}

function applyScenario(scn) {
  for (const [k, v] of Object.entries(scn.params)) {
    // dropoutRatePerDay is a fraction, but the input is a percentage
    if (k === "dropoutRatePerDay") {
      const el = document.getElementById("dropoutRate");
      if (el) el.value = (v * 100);
      continue;
    }
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

function renderComparisonTable(rows, nReps) {
  const cmp = document.getElementById("scenarioCompare");
  if (!cmp) return;

  const header = `
    <div class="compare-title">Scenario comparison</div>
    <div class="compare-sub">
      Median of ${nReps} replications, with 5th–95th percentile band.
      Scenarios share the same base seed (paired comparison) to isolate the effect of policy change from random variation.
      “£ / week saved” divides incremental annual cost by the median reduction in median wait (weeks).
      Shown as “—” when wait does not improve or no extra capacity is added.
    </div>
  `;

  const tableHead = `
    <table class="compare-table">
      <thead>
        <tr>
          <th>Scenario</th>
          <th>Stable?</th>
          <th>Median wait (days)</th>
          <th>P90 wait (days)</th>
          <th>Seen ≤ 4 weeks</th>
          <th>£ / week saved</th>
        </tr>
      </thead>
      <tbody>
  `;

  const body = rows.map(r => `
    <tr>
      <td>${r.name}</td>
      <td>${r.stable ? "✓" : "<span class='warn'>✗ unstable</span>"}</td>
      <td>${fmtBand(r.s.medianWait, 0)}</td>
      <td>${fmtBand(r.s.p90Wait, 0)}</td>
      <td>${fmtBand(r.s.within28, 1, true)}</td>
      <td>${r.costPerWeekSaved}</td>
    </tr>
  `).join("");

  cmp.innerHTML = header + tableHead + body + `</tbody></table>`;
}

function runAllComparisons() {
  renderAssumptionsPanel();

  const params = getParamsFromInputs();
  const scenarios = buildScenariosFromCurrentInputs();
  const baseline = scenarios.baseline;
  const baselineOut = simulate(baseline.params, params.nReps);
  const baselineMedian = baselineOut.summary.medianWait.median;

  const rows = Object.values(scenarios).map(s => {
    const out = simulate(s.params, params.nReps);
    const incCost = estimateIncrementalAnnualCost(baseline.params, s.params);

    const scenMedian = out.summary.medianWait.median;
    const weeksSaved =
      (baselineMedian !== null && scenMedian !== null)
        ? (baselineMedian - scenMedian) / 7
        : null;

    let costPerWeekSaved = "—";
    if (incCost > 0 && weeksSaved && weeksSaved > 0.05) {
      costPerWeekSaved = fmtGBP(incCost / weeksSaved);
    }

    return {
      name: s.name,
      s: out.summary,
      stable: !out.isUnstable,
      costPerWeekSaved
    };
  });

  lastComparisonRows = rows;
  renderComparisonTable(rows, params.nReps);

  const exportBtn = document.getElementById("exportCsvBtn");
  if (exportBtn) exportBtn.disabled = false;
}

// -------------------- CSV Export --------------------
function toCSV(rows) {
  const header = [
    "Scenario", "Stable",
    "MedianWait_median", "MedianWait_p05", "MedianWait_p95",
    "P90Wait_median", "P90Wait_p05", "P90Wait_p95",
    "SeenWithin4Weeks_median", "SeenWithin4Weeks_p05", "SeenWithin4Weeks_p95",
    "CostPerWeekSavedGBP"
  ];
  const lines = [header.join(",")];

  for (const r of rows) {
    const cost = (r.costPerWeekSaved || "").replace(/[£,]/g, "");
    const row = [
      `"${r.name.replace(/"/g, '""')}"`,
      r.stable ? "yes" : "no",
      r.s.medianWait.median ?? "", r.s.medianWait.p05 ?? "", r.s.medianWait.p95 ?? "",
      r.s.p90Wait.median ?? "",    r.s.p90Wait.p05 ?? "",    r.s.p90Wait.p95 ?? "",
      r.s.within28.median ?? "",   r.s.within28.p05 ?? "",   r.s.within28.p95 ?? "",
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
  "arrivalRate","capacityPerDay","dnaRate","rebookRate","rebookDelay","dropoutRate",
  "days","warmup","seed","nReps","wteCostAnnual","slotsPerWTE"
].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", renderAssumptionsPanel);
});

// Initial render
renderAssumptionsPanel();
run();
