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
  '🛰️ Ảnh vệ tinh (Google)': L.tileLayer(
    'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    { maxZoom: 20, attribution: '© Google Satellite' }
  ),
  '🗺️ Bản đồ đường phố (OSM)': L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '© OpenStreetMap, Esri' }
  ),
  '🏔️ Địa hình (Esri Topo)': L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '© Esri, USGS, NOAA' }
  )
};

// Clean reference boundaries & places layer (no watermark, no API key required)
const referenceLabels = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  {
    pane: 'labelsPane',
    maxZoom: 19,
    attribution: '© Esri'
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

// State for active basemap (default: Google Satellite)
let activeBasemapName = '🛰️ Ảnh vệ tinh (Google)';

// Add default basemap: Google Satellite
basemaps[activeBasemapName].addTo(map);

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

// Listen to basemap changes to manage reference labels and remember active basemap
map.on('baselayerchange', (e) => {
  activeBasemapName = e.name;
  updateLabelsVisibility(e.name);
});

// Initial label check (default is Google Satellite, so reference labels are visible)
updateLabelsVisibility(activeBasemapName);

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
    // Standard mode: restore previously active basemap and its labels
    mapElement.style.backgroundColor = '';
    const basemapToRestore = basemaps[activeBasemapName] || basemaps['🛰️ Ảnh vệ tinh (Google)'];
    basemapToRestore.addTo(map);
    updateLabelsVisibility(activeBasemapName);

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
const sidebar         = document.getElementById('sidebar');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const closeSidebarBtn  = document.getElementById('close-sidebar-btn');

// Collapsible Sidebar Toggle Logic (Desktop & Mobile)
if (sidebar) {
  const setSidebarCollapsed = (collapsed) => {
    sidebar.classList.toggle('collapsed', collapsed);
    sidebar.classList.toggle('mobile-open', !collapsed);
    if (sidebarToggleBtn) {
      sidebarToggleBtn.style.display = collapsed ? 'flex' : 'none';
    }
  };

  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', () => setSidebarCollapsed(false));
  }
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', () => setSidebarCollapsed(true));
  }

  // Auto-collapse sidebar on smaller mobile screens (< 600px) on initial load for maximum map space
  if (window.innerWidth < 640) {
    setSidebarCollapsed(true);
  }
}

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
  setTimeout(() => errorBanner.classList.remove('visible'), 7000);
}

function setMapLoading(loading) {
  if (spinner) spinner.classList.toggle('visible', loading);
}

function updateStatus(text, type = 'info') {
  if (statusText) statusText.innerText  = text;
  if (statusPanel) statusPanel.className = `status-panel ${type}`;
}

// ─── Dynamic Horizontal Gradient Colorbar (Bottom-Right) ──────
function renderLegend(layerType) {
  const templates = {
    ndvi: `
      <div class="legend-header-line">
        <span class="legend-bar-title">Mảng xanh (NDVI)</span>
        <span class="legend-bar-unit">-0.1 → 0.6+</span>
      </div>
      <div class="legend-gradient-track ndvi-bar"></div>
      <div class="legend-labels-row">
        <span>0.0 Đất trống</span>
        <span>0.25</span>
        <span>0.5+ Cây dày</span>
      </div>`,
    lst: `
      <div class="legend-header-line">
        <span class="legend-bar-title">Nhiệt độ bề mặt (LST)</span>
        <span class="legend-bar-unit">°C</span>
      </div>
      <div class="legend-gradient-track lst-bar"></div>
      <div class="legend-labels-row">
        <span>26°C Mát mẻ</span>
        <span>32°C</span>
        <span>38°C+ Rất nóng</span>
      </div>`,
    utfvi: `
      <div class="legend-header-line">
        <span class="legend-bar-title">Chỉ số sinh thái (UTFVI)</span>
        <span class="legend-bar-unit">&lt; 0.000 → &gt; 0.020</span>
      </div>
      <div class="utfvi-steps-bar">
        <div class="utfvi-step" style="background:#008000" title="< 0.000: Rất tốt"></div>
        <div class="utfvi-step" style="background:#90EE90" title="0.000–0.005: Tốt"></div>
        <div class="utfvi-step" style="background:#FFFF00" title="0.005–0.010: Trung bình"></div>
        <div class="utfvi-step" style="background:#FFA500" title="0.010–0.015: Xấu"></div>
        <div class="utfvi-step" style="background:#FF0000" title="0.015–0.020: Rất xấu"></div>
        <div class="utfvi-step" style="background:#800080" title="> 0.020: Nguy kịch"></div>
      </div>
      <div class="legend-labels-row">
        <span>Tốt (&lt; 0)</span>
        <span>Trung bình</span>
        <span>Nguy kịch (&gt; 0.02)</span>
      </div>`
  };

  if (legendContainer) {
    legendContainer.innerHTML = templates[layerType] ?? '';
    legendContainer.classList.toggle('visible', !!templates[layerType]);
  }
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

// ─── Feature 1: Spatial Value Inspector (Point Query Tooltip) ──
let inspectorPopup = null;

map.on('click', async (e) => {
  const { lat, lng } = e.latlng;
  const currentYear = yearSelect.value || '2025';

  // Show temporary loading popup
  inspectorPopup = L.popup({
    className: 'gis-inspector-popup',
    offset: [0, -4],
    closeButton: true
  })
    .setLatLng(e.latlng)
    .setContent(`
      <div class="inspector-card">
        <div class="inspector-header">
          <span class="inspector-title">Truy vấn tọa độ</span>
          <span class="inspector-coord">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px; font-size:0.74rem; color:#94a3b8; padding: 6px 0;">
          <span class="status-indicator warning" style="animation: pulse 1s infinite;"></span>
          Đang lấy mẫu raster GEE (Năm ${currentYear})...
        </div>
      </div>
    `)
    .openOn(map);

  try {
    const res = await fetch(`/api/query/point?lat=${lat}&lng=${lng}&year=${currentYear}`);
    const data = await res.json();

    if (!data || !data.insideRoi) {
      inspectorPopup.setContent(`
        <div class="inspector-card">
          <div class="inspector-header">
            <span class="inspector-title">Truy vấn tọa độ</span>
            <span class="inspector-coord">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
          </div>
          <div style="font-size:0.74rem; color:#f87171; padding: 4px 0;">
            ${data.message || 'Điểm nằm ngoài phạm vi quan trắc TP.HCM.'}
          </div>
        </div>
      `);
      return;
    }

    inspectorPopup.setContent(`
      <div class="inspector-card">
        <div class="inspector-header">
          <span class="inspector-title">Chỉ số Pixel (${data.year})</span>
          <span class="inspector-coord">${data.lat}, ${data.lng}</span>
        </div>
        <div class="inspector-grid">
          <div class="inspector-row">
            <span class="inspector-label">Nhiệt độ bề mặt (LST):</span>
            <span class="inspector-val" style="color: #f87171;">${data.lst} °C</span>
          </div>
          <div class="inspector-row">
            <span class="inspector-label">Chỉ số mảng xanh (NDVI):</span>
            <span class="inspector-val" style="color: #4ade80;">${data.ndvi}</span>
          </div>
          <div class="inspector-row">
            <span class="inspector-label">Tổn thương nhiệt (UTFVI):</span>
            <span class="inspector-badge" style="background-color: ${data.utfviColor}; color: ${data.utfviClass >= 3 ? '#ffffff' : '#0f172a'};">
              ${data.utfviLabel}
            </span>
          </div>
          <div class="inspector-row" style="font-size: 0.68rem; color: #64748b; margin-top: 2px;">
            <span>Mức đảo nhiệt:</span>
            <span style="font-weight:600; color:#cbd5e1;">${data.utfviUhi}</span>
          </div>
        </div>
      </div>
    `);
  } catch (err) {
    if (inspectorPopup) {
      inspectorPopup.setContent(`
        <div class="inspector-card">
          <div class="inspector-header">
            <span class="inspector-title">Lỗi kết nối</span>
          </div>
          <div style="font-size:0.72rem; color:#f87171;">Không thể tải dữ liệu pixel: ${err.message}</div>
        </div>
      `);
    }
  }
});

// ─── Feature 2: Split-Screen Synchronized Map Comparison ───────
let mapLeft = null;
let mapRight = null;
let leftGeeLayer = null;
let rightGeeLayer = null;
let isSyncing = false; // Prevents infinite event recursion loop
let compareCursorMarkerLeft = null;
let compareCursorMarkerRight = null;

const compareOverlay      = document.getElementById('compare-overlay');
const btnOpenCompare      = document.getElementById('btn-open-compare');
const btnCloseCompare     = document.getElementById('btn-close-compare');
const compareYearLeft     = document.getElementById('compare-year-left');
const compareYearRight    = document.getElementById('compare-year-right');
const compareLayerSelect  = document.getElementById('compare-layer-select');
const labelMapLeft        = document.getElementById('label-map-left');
const labelMapRight       = document.getElementById('label-map-right');

function initCompareMaps() {
  if (mapLeft && mapRight) return;

  const currentCenter = map.getCenter();
  const currentZoom   = map.getZoom();

  // Create Left Map
  mapLeft = L.map('compare-map-left', {
    zoomControl: true,
    attributionControl: false
  }).setView(currentCenter, currentZoom);

  // Create Right Map
  mapRight = L.map('compare-map-right', {
    zoomControl: false,
    attributionControl: false
  }).setView(currentCenter, currentZoom);

  // Base layers for compare maps
  L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { maxZoom: 20 }).addTo(mapLeft);
  L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { maxZoom: 20 }).addTo(mapRight);

  // Synchronized crosshairs
  const crosshairIcon = L.divIcon({
    className: 'compare-crosshair',
    html: '<div style="width:12px;height:12px;border:2px solid #38bdf8;border-radius:50%;box-shadow:0 0 8px #38bdf8;transform:translate(-6px,-6px);"></div>',
    iconSize: [0, 0]
  });

  compareCursorMarkerLeft  = L.marker(currentCenter, { icon: crosshairIcon, interactive: false }).addTo(mapLeft);
  compareCursorMarkerRight = L.marker(currentCenter, { icon: crosshairIcon, interactive: false }).addTo(mapRight);

  // Bi-directional view sync with isSyncing flag
  function syncView(sourceMap, targetMap) {
    if (isSyncing) return;
    isSyncing = true;
    targetMap.setView(sourceMap.getCenter(), sourceMap.getZoom(), { animate: false });
    isSyncing = false;
  }

  mapLeft.on('move', () => syncView(mapLeft, mapRight));
  mapRight.on('move', () => syncView(mapRight, mapLeft));

  // Bi-directional crosshair pointer tracking
  mapLeft.on('mousemove', (e) => {
    compareCursorMarkerLeft.setLatLng(e.latlng);
    compareCursorMarkerRight.setLatLng(e.latlng);
  });
  mapRight.on('mousemove', (e) => {
    compareCursorMarkerLeft.setLatLng(e.latlng);
    compareCursorMarkerRight.setLatLng(e.latlng);
  });
}

async function loadCompareLayers() {
  const layerType = compareLayerSelect.value;
  const yearL = compareYearLeft.value;
  const yearR = compareYearRight.value;

  const typeLabels = {
    lst: 'LST (°C)',
    ndvi: 'NDVI',
    utfvi: 'UTFVI'
  };

  labelMapLeft.textContent  = `${yearL} - ${typeLabels[layerType]}`;
  labelMapRight.textContent = `${yearR} - ${typeLabels[layerType]}`;

  try {
    const [resL, resR] = await Promise.all([
      fetch(`/api/map/${layerType}?year=${yearL}`).then(r => r.json()),
      fetch(`/api/map/${layerType}?year=${yearR}`).then(r => r.json())
    ]);

    if (leftGeeLayer) mapLeft.removeLayer(leftGeeLayer);
    if (rightGeeLayer) mapRight.removeLayer(rightGeeLayer);

    if (resL.url) {
      leftGeeLayer = L.tileLayer(resL.url, { opacity: 0.85, maxZoom: 20 }).addTo(mapLeft);
    }
    if (resR.url) {
      rightGeeLayer = L.tileLayer(resR.url, { opacity: 0.85, maxZoom: 20 }).addTo(mapRight);
    }
  } catch (err) {
    console.error('Error loading compare layers:', err);
  }
}

function openCompareMode() {
  compareOverlay.classList.add('active');
  initCompareMaps();
  setTimeout(() => {
    mapLeft.invalidateSize();
    mapRight.invalidateSize();
    mapLeft.setView(map.getCenter(), map.getZoom(), { animate: false });
    loadCompareLayers();
  }, 100);
}

function closeCompareMode() {
  compareOverlay.classList.remove('active');
}

btnOpenCompare?.addEventListener('click', openCompareMode);
btnCloseCompare?.addEventListener('click', closeCompareMode);
compareYearLeft?.addEventListener('change', loadCompareLayers);
compareYearRight?.addEventListener('change', loadCompareLayers);
compareLayerSelect?.addEventListener('change', loadCompareLayers);

// ─── Feature 3: Regional Time-Series Chart (Quận/Huyện) ─────────
const districtModal       = document.getElementById('district-modal');
const btnOpenDistrictModal = document.getElementById('btn-open-district-chart');
const btnCloseDistrictModal = document.getElementById('btn-close-district-modal');
const districtSelect      = document.getElementById('district-select');
const chartTabBtns        = document.querySelectorAll('.chart-tab-btn');

let districtChartInstance = null;
let districtDataCache = null;
let currentChartMetric = 'lst';

async function fetchDistrictStats() {
  if (districtDataCache) return districtDataCache;
  try {
    const res = await fetch('/api/stats/districts');
    const json = await res.json();
    districtDataCache = json;
    
    // Populate district select
    districtSelect.innerHTML = '';
    json.districts.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      districtSelect.appendChild(opt);
    });
    return json;
  } catch (err) {
    console.error('Error fetching district stats:', err);
    return null;
  }
}

function renderDistrictChart(districtName, metric) {
  if (!districtDataCache) return;
  const distInfo = districtDataCache.data[districtName];
  if (!distInfo) return;

  const canvas = document.getElementById('district-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (districtChartInstance) {
    districtChartInstance.destroy();
  }

  const metricConfigs = {
    lst: {
      label: 'Nhiệt độ bề mặt trung bình (°C)',
      data: distInfo.lst,
      borderColor: '#f87171',
      bgColor: 'rgba(248, 113, 113, 0.15)',
      unit: '°C',
      min: 25,
      max: 40
    },
    ndvi: {
      label: 'Chỉ số thực vật trung bình (NDVI)',
      data: distInfo.ndvi,
      borderColor: '#4ade80',
      bgColor: 'rgba(74, 222, 128, 0.15)',
      unit: '',
      min: 0,
      max: 0.8
    },
    utfvi: {
      label: 'Mức tổn thương sinh thái (UTFVI Class)',
      data: distInfo.utfvi,
      borderColor: '#c084fc',
      bgColor: 'rgba(192, 132, 252, 0.15)',
      unit: '',
      min: 0,
      max: 5.5
    }
  };

  const cfg = metricConfigs[metric];

  // Chart.js Configuration
  districtChartInstance = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels: distInfo.years,
      datasets: [{
        label: `${cfg.label} - ${districtName}`,
        data: cfg.data,
        borderColor: cfg.borderColor,
        backgroundColor: cfg.bgColor,
        borderWidth: 2.5,
        fill: true,
        tension: 0.35,
        pointBackgroundColor: cfg.borderColor,
        pointBorderColor: '#0f172a',
        pointBorderWidth: 2,
        pointRadius: 4.5,
        pointHoverRadius: 7
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          labels: {
            color: '#cbd5e1',
            font: { family: 'Inter', size: 12, weight: '600' }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#38bdf8',
          bodyColor: '#f8fafc',
          borderColor: '#334155',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: (item) => `${cfg.label}: ${item.raw} ${cfg.unit}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(51, 65, 85, 0.3)' },
          ticks: { color: '#94a3b8', font: { family: 'Inter' } }
        },
        y: {
          min: cfg.min,
          max: cfg.max,
          grid: { color: 'rgba(51, 65, 85, 0.3)' },
          ticks: {
            color: '#94a3b8',
            font: { family: 'Inter' },
            callback: (val) => `${val} ${cfg.unit}`
          }
        }
      }
    }
  });
}

async function openDistrictModal() {
  districtModal.classList.add('active');
  await fetchDistrictStats();
  const selectedDistrict = districtSelect.value || 'Quận 1';
  renderDistrictChart(selectedDistrict, currentChartMetric);
}

function closeDistrictModal() {
  districtModal.classList.remove('active');
}

btnOpenDistrictModal?.addEventListener('click', openDistrictModal);
btnCloseDistrictModal?.addEventListener('click', closeDistrictModal);

districtModal?.addEventListener('click', (e) => {
  if (e.target === districtModal) closeDistrictModal();
});

districtSelect?.addEventListener('change', () => {
  renderDistrictChart(districtSelect.value, currentChartMetric);
});

chartTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    chartTabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentChartMetric = btn.getAttribute('data-metric');
    renderDistrictChart(districtSelect.value, currentChartMetric);
  });
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

  // Pre-fetch district metrics in background so opening the modal is instant
  fetchDistrictStats();

  // Load NDVI by default on startup
  loadGMapLayer('ndvi', 'Mảng xanh (NDVI)');
}

document.addEventListener('DOMContentLoaded', init);
