const $ = (id) => document.getElementById(id);
const placeInput = $('placeInput');
const lookupBtn = $('lookupBtn');
const searchForm = $('searchForm');
const resultEl = $('result');
const statusEl = $('status');
const answerEl = $('answer');
const detailsEl = $('details');
const chipsEl = $('chips');
const geoBtn = $('geoBtn');
const demoBtn = $('demoBtn');

async function safeFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0,140)}` : ''}`);
  }
  return res.json();
}

function setLoading(msg = 'Loading…') {
  statusEl.innerHTML = `<span class="spinner"></span>${msg}`;
  answerEl.hidden = true;
  detailsEl.hidden = true;
  chipsEl.hidden = true;
  lookupBtn.disabled = true;
  geoBtn.disabled = true;
  demoBtn.disabled = true;
}
function clearLoading() {
  lookupBtn.disabled = false;
  geoBtn.disabled = false;
  demoBtn.disabled = false;
}
function mm(n) { return typeof n === 'number' && isFinite(n) ? n : 0; }
function formatPlace(p) {
  const bits = [p.name, p.admin1, p.country_code].filter(Boolean);
  return bits.join(', ');
}
function renderChips(items) {
  chipsEl.innerHTML = items.map((x) => `<span class="chip">${x}</span>`).join('');
  chipsEl.hidden = items.length === 0;
}
function showError(err) {
  clearLoading();
  statusEl.innerHTML = `<span class="err">${err}</span>`;
  answerEl.hidden = true;
  detailsEl.hidden = true;
  chipsEl.hidden = true;
}

async function geocodePlace(q) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', q);
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');
  const data = await safeFetch(url.toString());
  if (!data.results || data.results.length === 0)
    throw new Error('No matching place found.');
  const r = data.results[0];
  return { lat: r.latitude, lon: r.longitude, pretty: formatPlace(r) };
}

// --- Fixed version: avoid future timestamps ---
async function fetchRainLast24h(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly', 'rain,precipitation');
  url.searchParams.set('past_days', '2');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('current_weather', 'true');

  const data = await safeFetch(url.toString());
  const tzName = data.timezone;
  const hours = data.hourly?.time || [];
  const rainArr = data.hourly?.rain || [];
  const precipArr = data.hourly?.precipitation || [];

  if (!hours.length || !rainArr.length) {
    throw new Error('No hourly rain data available for this location.');
  }

  // Clip to the last hour that is not in the future (local tz from API)
  const nowStr = data.current_weather?.time; // e.g. "2025-08-10T11:45"
  let nowIdx = hours.length - 1;
  if (nowStr) {
    for (let i = hours.length - 1; i >= 0; i--) {
      if (hours[i] <= nowStr) { nowIdx = i; break; } // safe lexicographic compare
    }
  }
  const startIdx = Math.max(0, nowIdx - 23); // previous 24 hours inclusive
  let totalRain = 0, hoursWithRain = 0, lastHourString = '', sample = [];

  for (let i = startIdx; i <= nowIdx; i++) {
    const r = mm(rainArr[i]);
    const p = mm(precipArr?.[i]);
    totalRain += r;
    if (r > 0) hoursWithRain++;
    if (sample.length < 6 && (r > 0 || p > 0)) {
      sample.push(`${hours[i]} → rain ${r.toFixed(1)}mm`);
    }
    lastHourString = hours[i];
  }

  const rained = totalRain >= 0.1 || hoursWithRain > 0;
  return {
    rained,
    totalRain: Number(totalRain.toFixed(2)),
    hoursWithRain,
    lastHourString,
    tzName,
    sample
  };
}

async function handleCoords(lat, lon, prettyLabel) {
  try {
    setLoading('Checking the last 24 hours…');
    const res = await fetchRainLast24h(lat, lon);
    clearLoading();

    answerEl.hidden = false;
    answerEl.textContent = res.rained ? 'YES' : 'NO';

    const facts = [
      `Total rain: ${res.totalRain} mm`,
      `Rainy hours: ${res.hoursWithRain}/24`,
      `Timezone: ${res.tzName}`,
    ];

    const where = prettyLabel ? ` for ${prettyLabel}` : '';
    detailsEl.hidden = false;
    detailsEl.innerHTML = [
      `Based on hourly observations in the previous 24 hours${where}.`,
      res.lastHourString ? `Last hour checked: ${res.lastHourString} (${res.tzName}).` : ''
    ].filter(Boolean).join(' ');

    renderChips(facts);
    statusEl.textContent = '';
    if (res.sample.length) {
      const ul = document.createElement('ul');
      ul.className = 'tiny';
      ul.style.marginTop = '8px';
      res.sample.forEach(s => {
        const li = document.createElement('li');
        li.textContent = s;
        ul.appendChild(li);
      });
      resultEl.appendChild(ul);
    }
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function handlePlaceQuery(q) {
  if (!q || !q.trim()) {
    showError('Please enter a location.');
    return;
  }
  setLoading('Finding that place…');
  try {
    const { lat, lon, pretty } = await geocodePlace(q.trim());
    await handleCoords(lat, lon, pretty);
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    clearLoading();
  }
}

searchForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  handlePlaceQuery(placeInput.value);
});

geoBtn.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    showError('Geolocation not supported in this browser.');
    return;
  }
  setLoading('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      try {
        // Use CORS-friendly reverse geocoder
        const rev = new URL('https://api.bigdatacloud.net/data/reverse-geocode-client');
        rev.searchParams.set('latitude', String(latitude));
        rev.searchParams.set('longitude', String(longitude));
        rev.searchParams.set('localityLanguage', 'en');
        const r = await safeFetch(rev.toString()).catch(() => null);
        const pretty = r
          ? [r.city || r.locality, r.principalSubdivision, r.countryCode]
              .filter(Boolean)
              .join(', ')
          : '';
        await handleCoords(latitude, longitude, pretty);
      } catch (e) {
        showError(e.message || String(e));
      } finally {
        clearLoading();
      }
    },
    (err) => {
      clearLoading();
      showError(err.message || 'Failed to get location permission.');
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
});

demoBtn.addEventListener('click', () => handlePlaceQuery('Tokyo'));
