function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6D2B79F5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda, rand) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

function simulate(params) {
  const {
    arrivalRate,
    capacityPerDay,
    dnaRate,
    rebookRate,
    rebookDelay,
    days,
    warmup,
    seed
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

  const within = (daysThreshold) =>
    n ? (waits.filter(w => w <= daysThreshold).length / n) : null;

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

let queueChart, waitChart;

function fmtPct(x) {
  if (x === null || Number.isNaN(x)) return "—";
  return (x * 100).toFixed(1) + "%";
}
function fmtNum(x, dp = 1) {
  if (x === null || Number.isNaN(x)) return "—";
  return x.toFixed(dp);
}

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

  const labels = counts.map((_, i) => `${i*binSize}-${i*binSize + (binSize-1)}`);
  return { labels, counts };
}

function run() {
  const params = {
    arrivalRate: parseFloat(document.getElementById("arrivalRate").value),
    capacityPerDay: parseInt(document.getElementById("capacityPerDay").value, 10),
    dnaRate: parseFloat(document.getElementById("dnaRate").value),
    rebookRate: parseFloat(document.getElementById("rebookRate").value),
    rebookDelay: parseInt(document.getElementById("rebookDelay").value, 10),
    days: parseInt(document.getElementById("days").value, 10),
    warmup: parseInt(document.getElementById("warmup").value, 10),
    seed: parseInt(document.getElementById("seed").value, 10)
  };

  const out = simulate(params);
  renderMetrics(out.metrics);

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
    data: {
      labels: hist.labels,
      datasets: [{ label: "Count", data: hist.counts }]
    },
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

document.getElementById("runBtn").addEventListener("click", run);
run();
