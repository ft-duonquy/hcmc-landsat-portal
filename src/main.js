// ============================================================
// Web GIS — Urban Heat Island Analysis, TP. Hồ Chí Minh
// Frontend mapping logic  (Leaflet.js + GEE backend)
// ============================================================

console.log('Khởi chạy ứng dụng Web GIS phân tích đảo nhiệt đô thị (UHI) TP.HCM...');

// ─── Constants ───────────────────────────────────────────────
const HCMC_CENTER  = [10.762622, 106.660172];
const DEFAULT_ZOOM = 11;
const GEE_TILE_OPTIONS = {
  attribution:       'Google Earth Engine & Landsat 8',
  maxZoom:           18,
  opacity:           0.7,       // blend: basemap labels stay visible
  keepBuffer:        8,         // pre-render extra tile rows/cols
  updateWhenZooming: false,     // prevents mid-zoom tile flicker
  updateWhenIdle:    true       // only refresh when pan/zoom finishes
};

// ─── Simplified HCMC boundary polygon (used for client-side mask only) ───
// 43-point approximation of the FAO/GAUL Ho Chi Minh City boundary.
// Pixel-perfect clipping is handled server-side in GEE.
const HCMC_POLYGON_COORDS = [
  [106.3605, 10.3718], [106.4192, 10.3723], [106.4750, 10.3891],
  [106.5311, 10.4005], [106.5738, 10.4339], [106.6024, 10.4720],
  [106.6285, 10.5180], [106.6620, 10.5555], [106.7048, 10.5770],
  [106.7446, 10.5919], [106.7887, 10.5936], [106.8301, 10.5810],
  [106.8669, 10.5620], [106.9001, 10.5357], [106.9328, 10.5066],
  [106.9649, 10.4840], [106.9918, 10.4541], [107.0155, 10.4238],
  [107.0347, 10.3993], [106.9650, 10.3980], [106.9450, 10.3550], [106.9150, 10.3450], [106.8850, 10.3550], [106.8750, 10.3950], [106.8400, 10.4200], [106.8100, 10.4600],
  [106.8078, 10.4746], [106.7759, 10.4900], [106.7445, 10.5090],
  [106.7110, 10.5231], [106.6763, 10.5311], [106.6418, 10.5350],
  [106.6074, 10.5303], [106.5735, 10.5204], [106.5421, 10.5041],
  [106.5106, 10.4852], [106.4807, 10.4630], [106.4507, 10.4425],
  [106.4227, 10.4196], [106.3989, 10.3975], [106.3779, 10.3818],
  [106.3605, 10.3718]
];

// ─── Inverted mask GeoJSON ────────────────────────────────────
// World bounding box with HCMC cut out as a hole → dark overlay
// outside city, transparent inside city with a neon cyan boundary.
const HCMC_MASK_GEOJSON = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      // Outer ring — full world extent (clockwise winding)
      [[-180, 90], [180, 90], [180, -90], [-180, -90], [-180, 90]],
      // Inner ring (hole) — HCMC boundary (counter-clockwise winding)
      [...HCMC_POLYGON_COORDS].reverse()
    ]
  },
  properties: {}
};

// ─── Map Initialization ───────────────────────────────────────
const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true   // better performance for many tile layers
}).setView(HCMC_CENTER, DEFAULT_ZOOM);

// Create custom panes for GEE and Labels
map.createPane('geePane');
map.getPane('geePane').style.zIndex = 400;

map.createPane('labelsPane');
map.getPane('labelsPane').style.zIndex = 650;

// Create pane for mask to sit between GEE layers and labels
map.createPane('maskPane');
map.getPane('maskPane').style.zIndex = 450;

L.control.zoom({ position: 'bottomright' }).addTo(map);

// ─── Basemap Layers ───────────────────────────────────────────
const basemaps = {
  '🗺️ Bản đồ đường phố (OSM)': L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors' }
  ),
  '🛰️ Ảnh vệ tinh (Google)': L.tileLayer(
    'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    { maxZoom: 20, attribution: '© Google Satellite' }
  ),
  '🏔️ Địa hình (Esri Topo)': L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '© Esri, USGS, NOAA' }
  )
};

// CartoDB Positron Labels layer for readability over heatmaps
const referenceLabels = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
  {
    pane: 'labelsPane',
    maxZoom: 20,
    attribution: '© CartoDB'
  }
);

// ─── GEE Overlay Layer Groups ─────────────────────────────────
const ndviGroup  = L.layerGroup();
const lstGroup   = L.layerGroup();
const utfviGroup = L.layerGroup();

const overlays = {
  '🌿 Mảng xanh (NDVI)': ndviGroup,
  '🌡️ Nhiệt độ bề mặt (LST)': lstGroup,
  '⚠️ Tổn thương sinh thái (UTFVI)': utfviGroup
};

// Add default basemap (OSM Street)
basemaps['🗺️ Bản đồ đường phố (OSM)'].addTo(map);

// Strictly split Layer Control: base layers and overlays
const layerControl = L.control.layers(basemaps, overlays, {
  position:       'topright',
  collapsed:      true,
  hideSingleBase: false
}).addTo(map);

// Reference Labels visibility logic: only show over Google Satellite or Esri Topo
function updateLabelsVisibility(basemapName) {
  const needsLabels = basemapName.includes('Ảnh vệ tinh') || basemapName.includes('Địa hình');
  if (needsLabels) {
    if (!map.hasLayer(referenceLabels)) {
      referenceLabels.addTo(map);
    }
  } else {
    if (map.hasLayer(referenceLabels)) {
      map.removeLayer(referenceLabels);
    }
  }
}

// Listen to basemap changes to manage reference labels
map.on('baselayerchange', (e) => {
  updateLabelsVisibility(e.name);
});

// Initial label check (default is OSM, so labels are hidden by default)
updateLabelsVisibility('🗺️ Bản đồ đường phố (OSM)');

// ─── VN2000 Coordinate System Configuration ──────────────────
const VN2000_CENTRAL_MERIDIANS = {
  "An Giang": 104.75,   // 104°45'
  "Bắc Ninh": 107.00,   // 107°00'
  "Cà Mau": 104.50,     // 104°30'
  "Cao Bằng": 105.75,   // 105°45'
  "Đắk Lắk": 108.50,    // 108°30'
  "Điện Biên": 103.00,  // 103°00'
  "Đồng Nai": 107.75,   // 107°45'
  "Đồng Tháp": 105.00,  // 105°00'
  "Gia Lai": 108.25,    // 108°15'
  "Hà Tĩnh": 105.50,    // 105°30'
  "Hưng Yên": 105.50,   // 105°30'
  "Khánh Hòa": 108.25,  // 108°15'
  "Lai Châu": 104.75,   // 104°45'
  "Lạng Sơn": 107.25,   // 107°15'
  "Lào Cai": 104.75,    // 104°45'
  "Lâm Đồng": 107.75,   // 107°45'
  "Nghệ An": 104.75,    // 104°45'
  "Ninh Bình": 105.00,  // 105°00'
  "Phú Thọ": 104.75,    // 104°45'
  "Quảng Ngãi": 108.00, // 108°00'
  "Quảng Ninh": 107.75, // 107°45'
  "Quảng Trị": 106.00,  // 106°00'
  "Sơn La": 104.00,     // 104°00'
  "Tây Ninh": 105.75,   // 105°45'
  "Thái Nguyên": 106.50,// 106°30'
  "Thành phố Hồ Chí Minh": 105.75 // 105°45' (Target Meridian for HCMC)
};

// Reprojects coordinates from VN2000 (x, y) to WGS84 (lng, lat)
function reprojectVN2000ToWGS84(coords, province = "Thành phố Hồ Chí Minh") {
  const cm = VN2000_CENTRAL_MERIDIANS[province] || 105.75;
  const k0 = 0.9999;
  const x0 = 500000;
  return coords.map(pt => {
    // If coordinates are already in WGS84 format, pass them through
    if (pt[0] > -180 && pt[0] < 180 && pt[1] > -90 && pt[1] < 90) {
      return pt;
    }
    const x = pt[0];
    const y = pt[1];
    const lat = y / 111111;
    const lng = cm + (x - x0) / (111111 * Math.cos(lat * Math.PI / 180) * k0);
    return [lng, lat];
  });
}





// Helper functions to enforce winding order for Focus Mode mask
function forceClockwiseLatLng(coords) {
  let sum = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const cur = coords[i]; const next = coords[i+1];
    sum += (next[1] - cur[1]) * (next[0] + cur[0]);
  }
  return sum < 0 ? coords.slice().reverse() : coords;
}

function forceCounterClockwiseLatLng(coords) {
  let sum = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const cur = coords[i]; const next = coords[i+1];
    sum += (next[1] - cur[1]) * (next[0] + cur[0]);
  }
  return sum > 0 ? coords.slice().reverse() : coords;
}

// ─── HCMC Boundary Layer & Focus Mode State ──────────────────────
const hcmcBoundaryLayer = L.layerGroup().addTo(map);

fetch('/api/boundary')
  .then(res => res.json())
  .then(boundary => {
    // Draw the crisp black boundary line wrapper strictly around the border edges
    L.geoJSON(boundary, {
      interactive: false,
      pane: 'maskPane',
      style: {
        fill:        false,
        color:       '#000000',
        weight:      3.5,
        opacity:     0.9
      }
    }).addTo(hcmcBoundaryLayer);
  })
  .catch(err => console.error('Error fetching 2026 HCMC boundary:', err));

// ─── Focus Mode Handler (Dark Isolation Mode) ────────────────────
function applyFocusMode(isFocus) {
  const mapElement = document.getElementById('map');
  const focusCard  = document.getElementById('btn-focus-mode');
  
  focusCard.classList.toggle('active', isFocus);

  if (isFocus) {
    // Pitch-black background: hide basemaps so clipped GEE heatmap stands out on #000000
    mapElement.style.backgroundColor = '#000000';
    Object.values(basemaps).forEach(layer => map.removeLayer(layer));
    if (referenceLabels) map.removeLayer(referenceLabels);

    // Set GEE layer opacity to 100% full saturation in focus mode
    const activeGroup = currentLayerKey === 'ndvi' ? ndviGroup : (currentLayerKey === 'lst' ? lstGroup : utfviGroup);
    activeGroup.eachLayer(layer => {
      if (layer.setOpacity) layer.setOpacity(1.0);
    });
  } else {
    // Standard mode: restore OSM basemap and labels
    mapElement.style.backgroundColor = '';
    basemaps['🗺️ Bản đồ đường phố (OSM)'].addTo(map);
    referenceLabels.addTo(map);

    const activeGroup = currentLayerKey === 'ndvi' ? ndviGroup : (currentLayerKey === 'lst' ? lstGroup : utfviGroup);
    activeGroup.eachLayer(layer => {
      if (layer.setOpacity) layer.setOpacity(0.7);
    });
  }
}

// ─── State ───────────────────────────────────────────────────
let currentLayerKey  = '';

// ─── DOM References ──────────────────────────────────────────
const statusPanel     = document.getElementById('status-panel');
const statusText      = document.getElementById('status-text');
const spinner         = document.getElementById('map-spinner');
const errorBanner     = document.getElementById('error-banner');
const errorMessage    = document.getElementById('error-message');
const legendContainer = document.getElementById('dynamic-legend');
const yearSelect      = document.getElementById('year-select');
const focusCheckbox   = document.getElementById('focus-mode-checkbox');
const focusCard       = document.getElementById('btn-focus-mode');

if (focusCheckbox && focusCard) {
  focusCheckbox.addEventListener('change', (e) => {
    applyFocusMode(e.target.checked);
  });
  focusCard.addEventListener('click', (e) => {
    if (e.target !== focusCheckbox && !e.target.classList.contains('slider')) {
      focusCheckbox.checked = !focusCheckbox.checked;
      applyFocusMode(focusCheckbox.checked);
    }
  });
}

// ─── UI Helpers ───────────────────────────────────────────────
function showError(msg) {
  errorMessage.innerText = msg;
  errorBanner.classList.add('visible');
  setTimeout(() => errorBanner.classList.remove('visible'), 9000);
}

function setMapLoading(loading) {
  spinner.classList.toggle('visible', loading);
}

function updateStatus(text, type = 'info') {
  statusText.innerText  = text;
  statusPanel.className = `status-panel ${type}`;
}

// ─── Dynamic Legend ───────────────────────────────────────────
function renderLegend(layerType) {
  const templates = {
    ndvi: `
      <div class="legend-title">Mật độ thực vật (NDVI)</div>
      <div class="legend-desc">Chỉ số thể hiện mức độ bao phủ và sức khỏe của thảm thực vật.</div>
      <div class="legend-scale">
        <div class="gradient-bar ndvi-gradient"></div>
        <div class="scale-labels">
          <span>0.0 (Đất trống)</span>
          <span>0.25</span>
          <span>0.5+ (Phủ xanh)</span>
        </div>
      </div>`,
    lst: `
      <div class="legend-title">Nhiệt độ bề mặt (LST — °C)</div>
      <div class="legend-desc">Nhiệt độ bề mặt đất được hiệu chỉnh phát xạ từ cảm biến nhiệt Landsat.</div>
      <div class="legend-scale">
        <div class="gradient-bar lst-gradient"></div>
        <div class="scale-labels">
          <span>26°C (Mát mẻ)</span>
          <span>32°C</span>
          <span>38°C+ (Rất nóng)</span>
        </div>
      </div>`,
    utfvi: `
      <div class="legend-title">Chỉ số Đảo nhiệt (UTFVI)</div>
      <div class="legend-desc">Đánh giá tác động sinh thái đô thị dựa trên chênh lệch nhiệt độ bề mặt.</div>
      <div class="utfvi-grid">
        <div class="utfvi-item"><span class="color-box" style="background:#008000"></span><span class="label"><strong>&lt; 0.000</strong>: Rất tốt</span></div>
        <div class="utfvi-item"><span class="color-box" style="background:#90EE90"></span><span class="label"><strong>0.000–0.005</strong>: Tốt</span></div>
        <div class="utfvi-item"><span class="color-box" style="background:#FFFF00"></span><span class="label"><strong>0.005–0.010</strong>: Trung bình</span></div>
        <div class="utfvi-item"><span class="color-box" style="background:#FFA500"></span><span class="label"><strong>0.010–0.015</strong>: Xấu</span></div>
        <div class="utfvi-item"><span class="color-box" style="background:#FF0000"></span><span class="label"><strong>0.015–0.020</strong>: Rất xấu</span></div>
        <div class="utfvi-item"><span class="color-box" style="background:#800080"></span><span class="label"><strong>&gt; 0.020</strong>: Nguy kịch</span></div>
      </div>`
  };

  legendContainer.innerHTML = templates[layerType] ?? '';
  legendContainer.classList.toggle('visible', !!templates[layerType]);
}

// ─── Core: Load GEE Layer ─────────────────────────────────────
/**
 * @param {string} layerKey   – 'ndvi' | 'lst' | 'utfvi'
 * @param {string} displayName
 * @param {boolean} forceReload – bypass same-layer guard (e.g. year changed)
 */
async function loadGMapLayer(layerKey, displayName, forceReload = false) {
  if (!forceReload && currentLayerKey === layerKey) return;

  const year = parseInt(yearSelect.value, 10);

  setMapLoading(true);
  updateStatus(`Đang tải lớp ${displayName} (${year}) từ GEE...`, 'loading');

  try {
    const response = await fetch(`/api/map/${layerKey}?year=${year}`);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.url) throw new Error('Phản hồi từ server không chứa URL bản đồ.');

    // Clear all GEE overlay groups to ensure mutual exclusivity
    ndviGroup.clearLayers();
    lstGroup.clearLayers();
    utfviGroup.clearLayers();

    // Create new tile layer with optimized options and explicit pane/opacity
    const isFocusMode = focusCheckbox && focusCheckbox.checked;
    const tileLayer = L.tileLayer(data.url, {
      attribution:       'Google Earth Engine & Landsat 8',
      maxZoom:           18,
      opacity:           isFocusMode ? 0.95 : 0.7,
      keepBuffer:        8,
      updateWhenZooming: false,
      updateWhenIdle:    true,
      pane:              'geePane'    // render on dedicated pane above basemaps
    });

    tileLayer.on('loading', ()  => setMapLoading(true));
    tileLayer.on('load',    ()  => {
      setMapLoading(false);
      updateStatus(`Lớp: ${displayName} — Năm ${year}`, 'success');
    });
    tileLayer.on('tileerror', (e) => {
      console.warn('Tile error:', e);
      setMapLoading(false);
      updateStatus('Lỗi khi tải một số mảnh bản đồ.', 'error');
    });

    // Add to the appropriate LayerGroup and make sure that group is added to the map
    if (layerKey === 'ndvi') {
      tileLayer.addTo(ndviGroup);
      if (!map.hasLayer(ndviGroup)) ndviGroup.addTo(map);
    } else if (layerKey === 'lst') {
      tileLayer.addTo(lstGroup);
      if (!map.hasLayer(lstGroup)) lstGroup.addTo(map);
    } else if (layerKey === 'utfvi') {
      tileLayer.addTo(utfviGroup);
      if (!map.hasLayer(utfviGroup)) utfviGroup.addTo(map);
    }

    currentLayerKey = layerKey;

    // Update active card UI
    document.querySelectorAll('.control-card').forEach(c => c.classList.remove('active'));
    document.getElementById(`btn-${layerKey}`)?.classList.add('active');

    renderLegend(layerKey);

  } catch (error) {
    console.error(`Error loading ${displayName}:`, error);
    setMapLoading(false);
    updateStatus(`Lỗi tải ${displayName}`, 'error');
    showError(`Không thể lấy dữ liệu GEE: ${error.message}`);
  }
}

// ─── Sync Leaflet Control Checkboxes with Frontend Cards ──────
map.on('overlayadd', (e) => {
  let key = '';
  if (e.layer === ndviGroup) key = 'ndvi';
  else if (e.layer === lstGroup) key = 'lst';
  else if (e.layer === utfviGroup) key = 'utfvi';

  if (key) {
    // Clear other GEE layers to maintain single active layer
    if (key !== 'ndvi') ndviGroup.clearLayers();
    if (key !== 'lst') lstGroup.clearLayers();
    if (key !== 'utfvi') utfviGroup.clearLayers();

    if (currentLayerKey !== key) {
      const names = {
        ndvi:  'Mảng xanh (NDVI)',
        lst:   'Nhiệt độ bề mặt (LST)',
        utfvi: 'Tổn thương sinh thái (UTFVI)'
      };
      loadGMapLayer(key, names[key]);
    }
  }
});

map.on('overlayremove', (e) => {
  let key = '';
  if (e.layer === ndviGroup) key = 'ndvi';
  else if (e.layer === lstGroup) key = 'lst';
  else if (e.layer === utfviGroup) key = 'utfvi';

  if (key && currentLayerKey === key) {
    currentLayerKey = '';
    document.querySelectorAll('.control-card').forEach(c => c.classList.remove('active'));
    renderLegend('');
  }
});

// ─── Initialization ───────────────────────────────────────────
function init() {
  updateStatus('Sẵn sàng. Chọn một lớp bản đồ phân tích.', 'success');

  // Layer control cards
  document.getElementById('btn-ndvi').addEventListener('click', () =>
    loadGMapLayer('ndvi', 'Mảng xanh (NDVI)'));

  document.getElementById('btn-lst').addEventListener('click', () =>
    loadGMapLayer('lst', 'Nhiệt độ bề mặt (LST)'));

  document.getElementById('btn-utfvi').addEventListener('click', () =>
    loadGMapLayer('utfvi', 'Tổn thương sinh thái (UTFVI)'));

  // Year selector — re-fetch the currently active layer when year changes
  yearSelect.addEventListener('change', () => {
    if (currentLayerKey) {
      const names = {
        ndvi:  'Mảng xanh (NDVI)',
        lst:   'Nhiệt độ bề mặt (LST)',
        utfvi: 'Tổn thương sinh thái (UTFVI)'
      };
      // forceReload = true bypasses same-layer guard
      loadGMapLayer(currentLayerKey, names[currentLayerKey], true);
    }
  });

  // Load NDVI by default on startup
  loadGMapLayer('ndvi', 'Mảng xanh (NDVI)');
}

document.addEventListener('DOMContentLoaded', init);
