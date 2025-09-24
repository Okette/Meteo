/* ==============================
   CONFIG
============================== */
const DEFAULT_PLACE = "Germignac";
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search?language=fr&count=8&name=";
const FORECAST_URL = ({ lat, lon }) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=Europe%2FParis`
  + `&current=temperature_2m,apparent_temperature,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_gusts_10m,wind_direction_10m`
  + `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index`
  + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max,wind_speed_10m_max`;

const PVGIS_URL = ({ lat, lon, peak }) => {
  const year = new Date().getFullYear();
  const angle = 35, aspect = 0, loss = 14;
  return `https://re.jrc.ec.europa.eu/api/v5_2/seriescalc?lat=${lat}&lon=${lon}`
    + `&startyear=${year}&endyear=${year}`
    + `&pvtechchoice=crystSi&peakpower=${peak}&mountingplace=free&angle=${angle}&aspect=${aspect}&loss=${loss}`
    + `&timeformat=iso8601&outputformat=json&browser=1&_=${Date.now()}`;
};

/* ==============================
   ÉTAT & OUTILS
============================== */
let chart;
let chartType = "line";     // "line" | "bar"
let useGusts  = false;      // vent moyen vs rafales
let lastData  = null;
let lastGeo   = { lat: null, lon: null };

const $ = (id) => document.getElementById(id);
const $status = $("status");
const $title = $("app-title");

function setStatus(msg, type = "info") {
  const colors = { info: "", ok: "text-emerald-600", warn: "text-amber-600", err: "text-red-600" };
  if (!$status) return;
  $status.className = `text-sm mt-2 ${colors[type] || ""}`;
  $status.textContent = msg || "";
}
const NX = (v, fb) => (v === null || v === undefined || Number.isNaN(v) ? fb : v);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function toFixed(n, d = 0) { return (n === null || n === undefined || Number.isNaN(n)) ? "—" : Number(n).toFixed(d); }
function arr(a) { return Array.isArray(a) ? a : []; }
const fmtHour = (t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit" });

/* --- util météo --- */
function beaufort(speedKmh) {
  const s = speedKmh || 0;
  return s < 2 ? 0 : s < 6 ? 1 : s < 12 ? 2 : s < 20 ? 3 : s < 29 ? 4 : s < 39 ? 5 : s < 50 ? 6 : s < 62 ? 7 : s < 75 ? 8 : s < 89 ? 9 : s < 103 ? 10 : s < 118 ? 11 : 12;
}
function degToArrow(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSO","SO","OSO","O","ONO","NO","NNO"];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}
function wmoIcon(code) {
  if (code === 0) return "fa-sun";
  if ([1, 2, 3].includes(code)) return "fa-cloud-sun";
  if ([45, 48].includes(code)) return "fa-smog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "fa-cloud-showers-heavy";
  if (code >= 71 && code <= 77) return "fa-snowflake";
  if (code >= 95) return "fa-cloud-bolt";
  return "fa-cloud";
}
function formatDay(d) {
  const dt = new Date(d);
  return dt.toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit" });
}

/* --- dégradé intelligent pour 7 jours (pluie + T°) --- */
function dayGradientSmart({ code, rain = 0, tmax = null }) {
  const r = clamp01(rain / 25);            // pluie 0..25 mm
  const t = tmax == null ? 0 : clamp01((tmax - 5) / 20); // 5°C→0, 25°C→1

  let c1, c2, baseAlpha = 0.10;
  if (code === 0) {               // beau
    c1 = [255, 255, 200]; c2 = [173, 216, 230]; baseAlpha = 0.12 + 0.18 * t;
  } else if ([1, 2, 3, 45, 48].includes(code)) { // nuageux
    c1 = [200, 200, 200]; c2 = [255, 255, 255]; baseAlpha = 0.12 + 0.05 * r + 0.10 * t;
  } else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) { // pluie
    c1 = [70, 130, 180]; c2 = [30, 60, 120]; baseAlpha = 0.15 + 0.25 * r + 0.05 * t;
  } else if (code >= 71 && code <= 77) {   // neige
    c1 = [180, 200, 255]; c2 = [255, 255, 255]; baseAlpha = 0.12 + 0.10 * r;
  } else if (code >= 95) {                 // orage
    c1 = [90, 90, 120]; c2 = [40, 40, 70]; baseAlpha = 0.15 + 0.15 * r;
  } else {                                 // défaut
    c1 = [230, 230, 230]; c2 = [250, 250, 250]; baseAlpha = 0.10 + 0.10 * t;
  }

  const a1 = clamp01(baseAlpha);
  const a2 = clamp01(baseAlpha * 0.9);
  return `linear-gradient(135deg, rgba(${c1[0]},${c1[1]},${c1[2]},${a1}), rgba(${c2[0]},${c2[1]},${c2[2]},${a2}))`;
}

/* ==============================
   TABS
============================== */
const tabButtons = {
  overview: $("tabbtn-overview"),
  weekmap:  $("tabbtn-weekmap"),
  weekhour: $("tabbtn-weekhour"),
  sun:      $("tabbtn-sun"),
};
const tabPanels = {
  overview: $("tab-overview"),
  weekmap:  $("tab-weekmap"),
  weekhour: $("tab-weekhour"),
  sun:      $("tab-sun"),
};

function activateTab(which) {
  Object.entries(tabButtons).forEach(([k, btn]) => {
    const active = k === which;
    btn?.classList.toggle("active", active);
    btn?.setAttribute("aria-selected", active ? "true" : "false");
  });
  Object.entries(tabPanels).forEach(([k, panel]) => { if (panel) panel.hidden = k !== which; });

  if (which === "weekmap"  && lastData) renderWeekMap(lastData);
  if (which === "weekhour" && lastData) { buildWeekHourTabs(); renderWeekHourly(0); }
  if (which === "sun"      && lastGeo.lat != null) loadPVGIS();
}

tabButtons.overview?.addEventListener("click", () => activateTab("overview"));
tabButtons.weekmap ?.addEventListener("click", () => activateTab("weekmap"));
tabButtons.weekhour?.addEventListener("click", () => activateTab("weekhour"));
tabButtons.sun     ?.addEventListener("click", () => activateTab("sun"));

/* ==============================
   UI (recherche + thème + interactions)
============================== */
$("themeToggle")?.addEventListener("click", () => {
  document.documentElement.classList.toggle("dark");
  localStorage.setItem("theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
});
(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.classList.toggle("dark", saved === "dark");
  else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.classList.add("dark");
})();

$("btnFetch")?.addEventListener("click", () => {
  const q = $("place").value.trim() || DEFAULT_PLACE;
  resolvePlace(q);
});
$("btnLocate")?.addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("Géolocalisation non supportée.", "warn");
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    setStatus("Position obtenue. Chargement météo…");
    await fetchAndRender({ name: "Autour de moi", lat: latitude, lon: longitude });
  }, () => setStatus("Impossible d'obtenir la position.", "err"), { enableHighAccuracy: true, timeout: 10000 });
});

// auto-suggestions
const suggestions = $("suggestions");
let debounce;
$("place")?.addEventListener("input", (e) => {
  clearTimeout(debounce);
  const q = e.target.value.trim();
  if (!q) { suggestions.classList.add("hidden"); suggestions.innerHTML = ""; return; }
  debounce = setTimeout(() => suggest(q), 250);
});
suggestions?.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-lat]");
  if (!li) return;
  suggestions.classList.add("hidden");
  $("place").value = li.dataset.label;
  fetchAndRender({ name: li.dataset.label, lat: Number(li.dataset.lat), lon: Number(li.dataset.lon) });
});

// toggles du graphe
document.addEventListener("click", (e)=>{
  if (e.target.closest("#toggleChart")) {
    chartType = chartType === "line" ? "bar" : "line";
    if (lastData) renderHourly(lastData);
  }
});
$("windMode")?.addEventListener("change", (e)=>{
  useGusts = e.target.checked;
  if (lastData) renderHourly(lastData);
});

// filtres carte horaire
["wh-temp","wh-rain","wh-wind"].forEach(id=>{
  $(id)?.addEventListener("change", ()=>{
    const activeBtn = document.querySelector("#wh-days .wh-daybtn.active");
    const idx = activeBtn ? Number(activeBtn.dataset.idx) : 0;
    renderWeekHourly(idx);
  });
});

/* ==============================
   DATA FLOW
============================== */
async function suggest(q) {
  try {
    const r = await fetch(GEO_URL + encodeURIComponent(q));
    if (!r.ok) throw new Error("geo http " + r.status);
    const j = await r.json();
    suggestions.innerHTML = (j.results || []).map(it => {
      const label = `${it.name}${it.admin1 ? `, ${it.admin1}` : ""}${it.country ? ` (${it.country_code})` : ""}`;
      return `<li class="px-3 py-2 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800" data-lat="${it.latitude}" data-lon="${it.longitude}" data-label="${label}">${label}</li>`;
    }).join("");
    suggestions.classList.toggle("hidden", !(j.results || []).length);
  } catch (e) {
    console.warn("[geo] ", e);
    suggestions.classList.add("hidden");
  }
}

async function resolvePlace(q) {
  try {
    setStatus("Recherche de la commune…");
    const r = await fetch(GEO_URL + encodeURIComponent(q));
    if (!r.ok) throw new Error("geo http " + r.status);
    const j = await r.json();
    if (!j.results?.length) return setStatus("Commune introuvable.", "warn");
    const best = j.results[0];
    const label = `${best.name}${best.admin1 ? `, ${best.admin1}` : ""} (${best.country_code})`;
    await fetchAndRender({ name: label, lat: best.latitude, lon: best.longitude });
  } catch (e) {
    console.error(e);
    setStatus("Erreur de géocodage.", "err");
  }
}

async function fetchAndRender({ name, lat, lon }) {
  try {
    setStatus(`Chargement des prévisions pour ${name}…`);
    if ($title) $title.textContent = name;
    lastGeo = { lat, lon };

    const r = await fetch(FORECAST_URL({ lat, lon }));
    if (!r.ok) throw new Error("forecast http " + r.status);
    const j = await r.json();

    j.current = j.current || {};
    j.hourly  = j.hourly  || {};
    j.daily   = j.daily   || {};

    lastData = j;

    renderNow(j);
    renderDaily(j);
    renderHourly(j);

    // onglets “cartes”
    if (!tabPanels.weekmap?.hidden) renderWeekMap(j);
    buildWeekHourTabs();
    if (!tabPanels.weekhour?.hidden) renderWeekHourly(0);

    // PVGIS si onglet visible
    if (!tabPanels.sun?.hidden) loadPVGIS();

    setStatus(`Données à jour — ${new Date().toLocaleString("fr-FR")}`, "ok");
  } catch (e) {
    console.error(e);
    setStatus("Erreur de récupération des données météo.", "err");
  }
}

/* ==============================
   RENDERERS — APERÇU
============================== */
function renderNow(j) {
  const c = j.current || {};
  $("obs-time").textContent = c.time ? new Date(c.time).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";
  $("temp-now").textContent  = toFixed(c.temperature_2m, 1);
  $("temp-feels").textContent= (c.apparent_temperature != null) ? `${toFixed(c.apparent_temperature, 1)}°C` : "—";
  $("rain-now").textContent  = toFixed(c.precipitation, 1);
  $("clouds").textContent    = toFixed(c.cloud_cover, 0);
  $("msl").textContent       = toFixed(c.pressure_msl, 0);

  const dewArr = arr(j.hourly.dew_point_2m);
  $("dew").textContent = dewArr.length ? `${toFixed(dewArr[0], 1)}°C` : "—";

  const wind = NX(c.wind_speed_10m, 0);
  const gust = NX(c.wind_gusts_10m, 0);
  const dir  = NX(c.wind_direction_10m, 0);
  $("wind").textContent     = `${toFixed(wind, 0)} km/h ${degToArrow(dir)}`;
  $("wind-gust").textContent= `${toFixed(gust, 0)} km/h`;
  $("wind-dir").textContent = `${toFixed(dir, 0)}° ${degToArrow(dir)}`;
  $("wind-bft").textContent = beaufort(wind);

  const uvDaily = arr(j.daily.uv_index_max);
  $("uv").textContent = uvDaily.length ? toFixed(uvDaily[0], 1) : "—";

  const popArr = arr(j.hourly.precipitation_probability);
  $("pop-now").textContent = popArr.length ? `${toFixed(popArr[0], 0)}` : "—";

  $("wind-bar").style.width = `${Math.min(100, (wind / 120) * 100)}%`;
}

/* --- GRAPHIQUE HORAIRE : gradient T° adaptatif + vent --- */
function renderHourly(j) {
  const hrs = arr(j.hourly.time);
  if (!hrs.length) return;

  const labels   = hrs.slice(0, 24).map(t => fmtHour(t));
  const tempArr  = arr(j.hourly.temperature_2m).slice(0, 24);
  let   popArr   = arr(j.hourly.precipitation_probability).slice(0, 24);
  const windMean = arr(j.hourly.wind_speed_10m).slice(0, 24);
  const windGust = arr(j.hourly.wind_gusts_10m).slice(0, 24);
  const windArr  = useGusts ? windGust : windMean;

  if (!popArr.length) {
    const rain = arr(j.hourly.precipitation).slice(0, 24);
    popArr = rain.map(v => (v > 0 ? 50 : 10));
  }

  const canvas = $("hourlyChart");
  if (!canvas) return;
  if (chart) chart.destroy();
  const ctx2d = canvas.getContext("2d");

  const tempColor = (context) => {
    const chart = context.chart;
    const { chartArea } = chart || {};
    if (!chartArea) return "#3fb37f";
    const grad = ctx2d.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
    grad.addColorStop(0, "#3fb37f");
    grad.addColorStop(0.5, "#f59e0b");
    grad.addColorStop(1, "#ef4444");
    return grad;
  };

  const blueFill  = "rgba(56,189,248,0.6)";
  const blueLine  = "rgba(56,189,248,0.9)";
  const windCol   = "rgba(100,116,139,0.9)";

  chart = new Chart(canvas, {
    type: chartType,
    data: {
      labels,
      datasets: [
        { label: "Température (°C)", data: tempArr, yAxisID: "y1", tension:.3, borderWidth:2, pointRadius:0,
          backgroundColor: chartType === "bar" ? tempColor : undefined,
          borderColor:     chartType === "line" ? tempColor : undefined },
        { label: "Prob. pluie (%)", data: popArr, yAxisID: "y2", tension:.3, borderWidth:2, pointRadius:0,
          backgroundColor: chartType === "bar" ? blueFill : undefined,
          borderColor:     chartType === "line" ? blueLine : undefined },
        { label: `Vent (${useGusts ? "rafales" : "moyen"}) (km/h)`, data: windArr, yAxisID: "y3", tension:.3, borderWidth:2, pointRadius:0,
          backgroundColor: chartType === "bar" ? "rgba(100,116,139,0.35)" : undefined,
          borderColor:     chartType === "line" ? windCol : undefined },
      ]
    },
    options: {
      animation: { duration: 250 },
      responsive: true,
      scales: {
        y1: { type:"linear", position:"left",
              suggestedMin: Math.min(...tempArr, 0) - 2,
              suggestedMax: Math.max(...tempArr, 10) + 2,
              grid:{ drawOnChartArea:true } },
        y2: { type:"linear", position:"right", min:0, max:100, grid:{ drawOnChartArea:false } },
        y3: { type:"linear", position:"right", min:0, suggestedMax: Math.max(...windArr, 30) + 10,
              grid:{ drawOnChartArea:false }, display:true, offset:true },
        x:  { ticks: { maxTicksLimit: 12 } }
      },
      plugins: { legend:{ display:true }, tooltip:{ mode:"index", intersect:false } }
    }
  });
}

/* --- 7 JOURS (dégradés pluie + T°) --- */
function renderDaily(j) {
  const root = $("daily");
  if (!root) return;
  root.innerHTML = "";

  const dates = arr(j.daily.time);
  const tmin  = arr(j.daily.temperature_2m_min);
  const tmax  = arr(j.daily.temperature_2m_max);
  const rain  = arr(j.daily.precipitation_sum);
  const wmo   = arr(j.daily.weather_code);

  dates.forEach((d, i) => {
    const icon = wmoIcon(wmo[i]);
    const bg   = dayGradientSmart({ code: wmo[i], rain: Number(NX(rain[i], 0)), tmax: NX(tmax[i], null) });
    const el = document.createElement("div");
    el.className = "day";
    el.style.backgroundImage = bg;
    el.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="font-semibold">${formatDay(d)}</div>
        <i class="fa-solid ${icon}"></i>
      </div>
      <div class="mt-2 text-2xl font-bold">${toFixed(tmax[i], 0)}°</div>
      <div class="text-sm opacity-80">Min ${toFixed(tmin[i], 0)}°</div>
      <div class="text-sm mt-2"><i class="fa-solid fa-umbrella mr-1"></i>${toFixed(rain[i], 1)} mm</div>
    `;
    root.appendChild(el);
  });
}

/* --- Carte de la semaine (jour par jour) --- */
function renderWeekMap(j) {
  const root = $("week-map");
  if (!root) return;
  root.innerHTML = "";

  const dates   = arr(j.daily.time);
  const tmin    = arr(j.daily.temperature_2m_min);
  const tmax    = arr(j.daily.temperature_2m_max);
  const rain    = arr(j.daily.precipitation_sum);
  const wmo     = arr(j.daily.weather_code);
  const windMax = arr(j.daily.wind_speed_10m_max);
  if (!dates.length) return;

  dates.forEach((d, i) => {
    const cell = document.createElement("div");
    cell.className = "weekcell";
    const icon = wmoIcon(wmo[i] ?? null);
    const day  = formatDay(d);
    const rainVal = Number(NX(rain[i], 0));
    const windVal = Number(NX(windMax[i], 0));

    const rainAlpha = Math.min(0.35, rainVal / 30);
    const windAlpha = Math.min(0.35, windVal / 80);
    cell.style.backgroundImage =
      `linear-gradient(135deg, rgba(99,102,241,${rainAlpha}), rgba(56,189,248,${windAlpha}))`;

    cell.innerHTML = `
      <div class="head">
        <div>${day}</div>
        <i class="fa-solid ${icon} icon"></i>
      </div>
      <div class="temps">
        <div class="tmax">${toFixed(tmax[i], 0)}°</div>
        <div class="tmin">/ ${toFixed(tmin[i], 0)}°</div>
      </div>
      <div class="row">
        <span class="chip"><i class="fa-solid fa-umbrella"></i> ${toFixed(rainVal, 1)} mm</span>
        <span class="chip"><i class="fa-solid fa-wind"></i> ${toFixed(windVal, 0)} km/h</span>
      </div>
    `;
    root.appendChild(cell);
  });
}

/* ==============================
   CARTE HORAIRE (semaine x heure)
============================== */
function buildWeekHourTabs() {
  const root = $("wh-days");
  if (!root || !lastData?.daily?.time) return;
  const dates = arr(lastData.daily.time);
  root.innerHTML = dates.map((d, i) => `
    <button class="wh-daybtn ${i===0?'active':''}" data-idx="${i}">
      ${new Date(d).toLocaleDateString("fr-FR", { weekday:"short", day:"2-digit" })}
    </button>
  `).join("");

  root.querySelectorAll(".wh-daybtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      root.querySelectorAll(".wh-daybtn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      renderWeekHourly(Number(btn.dataset.idx));
    });
  });
}

function pickWMOForHour(dailyCode, pop) {
  if ((pop ?? 0) >= 50) return 80; // averse
  return dailyCode ?? 1;           // nuageux par défaut
}

function renderWeekHourly(dayIndex=0) {
  const grid = $("wh-grid");
  if (!grid || !lastData) return;

  const H = lastData.hourly || {};
  const ht = arr(H.time);
  const t  = arr(H.temperature_2m);
  const pP = arr(H.precipitation_probability);
  const ws = arr(H.wind_speed_10m);
  const wmoD = arr(lastData.daily?.weather_code);

  if (!ht.length) { grid.innerHTML = ""; return; }

  const dayStart = new Date(lastData.daily.time[dayIndex]);
  const dayEnd   = new Date(dayStart); dayEnd.setDate(dayStart.getDate()+1);

  const idx = ht.map((x,i)=>({dt:new Date(x), i}))
                .filter(o => o.dt >= dayStart && o.dt < dayEnd)
                .map(o => o.i);

  const showTemp = $("wh-temp")?.checked ?? true;
  const showRain = $("wh-rain")?.checked ?? true;
  const showWind = $("wh-wind")?.checked ?? true;

  grid.innerHTML = idx.map(i => {
    const hour = fmtHour(ht[i]);
    const icon = wmoIcon(pickWMOForHour(wmoD[dayIndex], pP[i]));
    return `
      <div class="wh-col">
        <div class="wh-hour">
          <div class="h">${hour}</div>
          <div class="row"><span class="ico"><i class="fa-solid ${icon}"></i></span>Prévision</div>
          <div class="row ${showTemp?'':'hidden'}"><span class="ico"><i class="fa-solid fa-temperature-half"></i></span>${toFixed(t[i],0)}°</div>
          <div class="row ${showRain?'':'hidden'}"><span class="ico"><i class="fa-solid fa-umbrella"></i></span>${toFixed(pP[i] ?? 0,0)}%</div>
          <div class="row ${showWind?'':'hidden'}"><span class="ico"><i class="fa-solid fa-wind"></i></span>${toFixed(ws[i] ?? 0,0)} km/h</div>
        </div>
      </div>
    `;
  }).join("");
}

/* ==============================
   PVGIS — Ensoleillement & Énergie
============================== */
$("pvReload")?.addEventListener("click", loadPVGIS);

async function loadPVGIS() {
  const pvStat = $("pvStatus");
  const grid   = $("sun-grid");
  if (!pvStat || !grid) return;

  grid.innerHTML = "";
  if (location.protocol === "file:") {
    pvStat.textContent = "PVGIS bloqué en file:// — lance un petit serveur local (ex. « npx serve »).";
    return;
  }
  pvStat.textContent = "Chargement PVGIS…";

  const peak = Math.max(0.1, Number($("pvPeak").value || 3));
  if (lastGeo.lat == null) { pvStat.textContent = "Position inconnue."; return; }

  try {
    const url = PVGIS_URL({ lat:lastGeo.lat, lon:lastGeo.lon, peak });
    const r = await fetch(url);
    if (!r.ok) { pvStat.textContent = `Erreur PVGIS (${r.status})`; return; }
    const j = await r.json();

    const series = j?.outputs?.hourly || j?.outputs?.series || [];
    if (!series.length) { pvStat.textContent = "Données PVGIS indisponibles."; return; }

    const byDay = new Map();
    const thresholdW = peak * 1000 * 0.01; // 1% du pic
    for (const row of series) {
      const t = new Date(row.time || row.timestamp || row.date || row.time_utc);
      const dayKey = t.toISOString().slice(0,10);
      const P = Number(row.P ?? row.p ?? 0); // W (pas horaire)
      if (!byDay.has(dayKey)) byDay.set(dayKey, { Wh:0, sunH:0 });
      const obj = byDay.get(dayKey);
      obj.Wh  += P;                 // somme des pas horaires (Wh)
      if (P > thresholdW) obj.sunH += 1;
    }

    const today = new Date();
    const items = [];
    for (let i=0;i<7;i++){
      const d = new Date(today); d.setDate(today.getDate()+i);
      const key = d.toISOString().slice(0,10);
      const val = byDay.get(key) || { Wh: 0, sunH: 0 };
      items.push({ date: key, sunH: val.sunH, kWh: val.Wh/1000 });
    }

    grid.innerHTML = items.map(it => `
      <div class="weekcell">
        <div class="head">
          <div>${new Date(it.date).toLocaleDateString("fr-FR", { weekday:"short", day:"2-digit" })}</div>
          <i class="fa-solid fa-solar-panel icon"></i>
        </div>
        <div class="row">
          <span class="chip"><i class="fa-solid fa-sun"></i> ${toFixed(it.sunH,0)} h</span>
          <span class="chip"><i class="fa-solid fa-bolt"></i> ${toFixed(it.kWh,1)} kWh</span>
        </div>
        <div class="text-xs opacity-70 mt-2">Hypothèses : ${toFixed(peak,1)} kWc, 35° sud, pertes 14% (PVGIS)</div>
      </div>
    `).join("");

    pvStat.textContent = "PVGIS chargé.";
  } catch (e) {
    console.error(e);
    pvStat.textContent = "Erreur PVGIS.";
  }
}

/* ==============================
   BOOT
============================== */
window.addEventListener("DOMContentLoaded", () => {
  const place = $("place");
  if (place) place.value = DEFAULT_PLACE;
  activateTab("overview");
  resolvePlace(DEFAULT_PLACE);
});
