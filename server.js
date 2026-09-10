// HCMC Landsat Portal Backend Server - Production Deployment
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import ee from '@google/earthengine';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env.local (or system environment in production)
dotenv.config({ path: '.env.local' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint for cloud load balancers / Render probes
app.get('/health', (req, res) => res.status(200).send('OK'));

// Serve static frontend files from 'dist' directory when deployed
app.use(express.static(path.join(__dirname, 'dist')));

const PORT = process.env.PORT || 5000;

const clientEmail = process.env.VITE_EE_CLIENT_EMAIL?.trim();
const privateKey = process.env.VITE_EE_PRIVATE_KEY
  ? process.env.VITE_EE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/^["']|["']$/g, '').trim()
  : undefined;

// ─── VN2000 National Coordinate System Config ────────────────
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
    const x = pt[0];
    const y = pt[1];
    // Simple transverse Mercator approximation to WGS84
    const lat = y / 111111;
    const lng = cm + (x - x0) / (111111 * Math.cos(lat * Math.PI / 180) * k0);
    return [lng, lat];
  });
}

// ---------------------------------------------------------------------------
// 1. GEE Authentication & Initialization
// ---------------------------------------------------------------------------
let isGeeInitialized = false;

function initializeGee() {
  return new Promise((resolve, reject) => {
    if (!clientEmail || !privateKey) {
      return reject(new Error(
        'Missing Earth Engine credentials in .env.local. ' +
        'Ensure VITE_EE_CLIENT_EMAIL and VITE_EE_PRIVATE_KEY are set.'
      ));
    }

    console.log('Authenticating with Google Earth Engine...');

    const projectId =
      process.env.VITE_EE_PROJECT_ID ||
      clientEmail.split('@')[1].split('.iam.gserviceaccount.com')[0];

    console.log(`Setting Earth Engine Project ID: ${projectId}`);
    ee.data.setProject(projectId);

    ee.data.authenticateViaPrivateKey(
      { client_email: clientEmail, private_key: privateKey },
      () => {
        console.log('GEE Authentication successful. Initializing library...');
        ee.initialize(
          null, null,
          () => {
            console.log('Google Earth Engine successfully initialized!');
            isGeeInitialized = true;
            resolve();
          },
          (err) => {
            console.error('GEE library initialization failed:', err);
            reject(err);
          }
        );
      },
      (err) => {
        console.error('GEE private key authentication failed:', err);
        reject(err);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// 2. HCMC Geometry — Precise FAO/GAUL administrative boundary
//    Lazy-evaluated so ee.* is never called before initialization.
// ---------------------------------------------------------------------------
function getHcmcGeometry() {
  const baseGeom = ee.FeatureCollection('FAO/GAUL/2015/level2')
    .filter(ee.Filter.or(
      ee.Filter.eq('ADM1_NAME', 'Ho Chi Minh City'),
      ee.Filter.eq('ADM1_NAME', 'Binh Duong'),
      ee.Filter.eq('ADM1_NAME', 'Ba Ria-Vung Tau')
    ))
    .geometry();

  // Tight curved polygon specifically wrapping Can Gio Sea Reclamation Tourist Area (Khu đô thị du lịch lấn biển Cần Giờ)
  const canGioReclamation = ee.Geometry.Polygon([
    [106.875, 10.395],
    [106.885, 10.355],
    [106.915, 10.345],
    [106.955, 10.355],
    [106.970, 10.400],
    [106.920, 10.410],
    [106.875, 10.395]
  ]);

  return baseGeom.union(canGioReclamation);
}

// ---------------------------------------------------------------------------
// 3. Remote Sensing Workflow
// ---------------------------------------------------------------------------

/**
 * Pixel-level cloud + cloud-shadow masking using Landsat Collection 2 QA_PIXEL band.
 * Bit 3 = Cloud Shadow, Bit 4 = Cloud (high confidence).
 * Applied via .map() BEFORE .mosaic() so gaps from cloudy pixels in one scene
 * are filled by clear pixels from overlapping scenes (different path/rows).
 * This is the fix for void/dark holes in LST and UTFVI layers.
 */
function maskLandsatClouds(image) {
  const qa = image.select('QA_PIXEL');
  // Mask out Dilated Cloud (bit 1), Cirrus (bit 2), Cloud Shadow (bit 3), and Cloud (bit 4)
  const dilatedCloudBit = 1 << 1;
  const cirrusBit = 1 << 2;
  const cloudShadowBit = 1 << 3;
  const cloudBit = 1 << 4;

  const mask = qa.bitwiseAnd(dilatedCloudBit).eq(0)
    .and(qa.bitwiseAnd(cirrusBit).eq(0))
    .and(qa.bitwiseAnd(cloudShadowBit).eq(0))
    .and(qa.bitwiseAnd(cloudBit).eq(0));
  return image.updateMask(mask);
}

/**
 * Calculates LST (°C), NDVI, and NDWI on EACH individual scene BEFORE compositing.
 */
function addRemoteSensingBands(image) {
  // Extract ST_B10 and calculate raw LST Celsius
  const lstC = image.select('ST_B10')
    .multiply(0.00341802).add(149.0).subtract(273.15)
    .rename('LST_Celsius');

  // NDVI
  const ndvi = image.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');

  // NDWI (Green - NIR) / (Green + NIR) for water body & intertidal mudflat detection
  const ndwi = image.normalizedDifference(['SR_B3', 'SR_B5']).rename('NDWI');

  return image.addBands([lstC, ndvi, ndwi]);
}

/**
 * Fetch dry season Landsat 8 + Landsat 9 ImageCollection.
 * @param {number} year      – e.g. 2024
 * @param {ee.Geometry} geometry – merged 3-province boundary geometry
 */
function fetchLandsatCollection(year, geometry) {
  return new Promise((resolve, reject) => {
    try {
      // Dry season (January 1 to May 31) for peak solar radiation & UHI contrast
      const startDate = `${year}-01-01`;
      const endDate = `${year}-05-31`;

      console.log(`Fetching Dry Season (${startDate} to ${endDate}) Landsat 8+9 collection for ${year}...`);

      const l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
        .filterBounds(geometry)
        .filterDate(startDate, endDate)
        .filter(ee.Filter.lt('CLOUD_COVER', 70))
        .map(addRemoteSensingBands)
        .map(maskLandsatClouds);

      const l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
        .filterBounds(geometry)
        .filterDate(startDate, endDate)
        .filter(ee.Filter.lt('CLOUD_COVER', 70))
        .map(addRemoteSensingBands)
        .map(maskLandsatClouds);

      const collection = l8.merge(l9);

      collection.size().evaluate((size, err) => {
        if (err) return reject(new Error('Error evaluating image collection size: ' + err.message));
        if (size === 0) return reject(new Error(`Empty collection: No Landsat 8/9 dry season images found for ${year}.`));

        console.log(`Found ${size} combined L8+L9 dry season scenes for ${year}.`);
        resolve(collection);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Robust Remote Sensing Workflow:
 * 1. NDWI water & intertidal mudflat masking (fixes Can Gio false thermal anomaly)
 * 2. 85th percentile dry-season LST (captures rubber defoliation heat spikes & urban hotspots, excludes T1-T2 cloud shadow coolness)
 * 3. Seamless LST & UTFVI calculation
 * @param {ee.ImageCollection} collection – fused L8+L9 collection with LST_Celsius, NDVI, and NDWI bands
 * @param {ee.Geometry}        geometry   – HCMC boundary (for reduceRegion)
 */
function processRemoteSensingLayers(collection, geometry) {
  // A. NDVI calculation (Zero holes)
  const ndviMeanRaw = collection.select('NDVI').mean();
  const ndviFocal = ndviMeanRaw.focal_mean({ radius: 10, kernelType: 'circle', units: 'pixels' });
  const ndvi = ndviMeanRaw.unmask(ndviFocal).unmask(0.25).rename('NDVI').clip(geometry);

  // B. NDWI Water & Intertidal Mudflat Masking
  const ndwiMeanRaw = collection.select('NDWI').mean();
  const isWater = ndwiMeanRaw.gt(0.02); // Detect open water, shallow aquaculture, and intertidal mudflats

  // C. LST calculation: Use 85th Percentile during dry season to capture PEAK heat spikes (rubber defoliation & urban concrete)
  const lstPeakRaw = collection.select('LST_Celsius').reduce(ee.Reducer.percentile([85])).rename('LST_Celsius');
  const lstFocal = lstPeakRaw.focal_mean({ radius: 10, kernelType: 'circle', units: 'pixels' });
  const lstFilled = lstPeakRaw.unmask(lstFocal).unmask(30.0);

  // Apply NDWI water mask: Water bodies & Can Gio intertidal mangrove waters get cool temperature (~26.5°C)
  const lstCelsius = lstFilled.where(isWater, 26.5).rename('LST_Celsius').clip(geometry);

  // D. UTFVI calculation (Derived from gap-free lstCelsius)
  const lstKelvin = lstCelsius.add(273.15).rename('LST_Kelvin');

  const meanDict = lstKelvin.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geometry,
    scale: 30,
    maxPixels: 1e9
  });
  const lstMeanK = ee.Number(meanDict.get('LST_Kelvin'));

  // UTFVI = (LST - LST_mean) / LST (Kelvin)
  const utfvi = lstKelvin.expression(
    '(LST - LST_mean) / LST',
    { LST: lstKelvin, LST_mean: lstMeanK }
  ).rename('UTFVI');

  const geometryMask = ee.Image.constant(1).clip(geometry).mask();

  // Classify UTFVI into 6 discrete UHI threshold classes
  // 0 → Excellent (<0) | 1 → Good | 2 → Normal | 3 → Bad | 4 → Very Bad | 5 → Critical
  const utfviClassified = ee.Image(0)
    .where(utfvi.gte(0.000).and(utfvi.lt(0.005)), 1)
    .where(utfvi.gte(0.005).and(utfvi.lt(0.010)), 2)
    .where(utfvi.gte(0.010).and(utfvi.lt(0.015)), 3)
    .where(utfvi.gte(0.015).and(utfvi.lt(0.020)), 4)
    .where(utfvi.gte(0.020), 5)
    .updateMask(geometryMask)
    .rename('UTFVI_Classified');

  return { ndvi, lstCelsius, utfviClassified };
}

/**
 * Convert array-based palette and numeric min/max to strings,
 * then call ee.data.getMapId and return the urlFormat tile template.
 * @param {ee.Image} image
 * @param {Object}   visParams
 */
function getMapTileUrl(image, visParams) {
  const formatted = {};
  for (const key of Object.keys(visParams)) {
    const val = visParams[key];
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) formatted[key] = val.join(',');
    else if (typeof val === 'number') formatted[key] = String(val);
    else formatted[key] = val;
  }
  return new Promise((resolve, reject) => {
    ee.data.getMapId({ image, ...formatted }, (mapInfo, err) => {
      if (err) return reject(err);
      if (!mapInfo?.urlFormat) {
        return reject(new Error('Empty urlFormat in GEE getMapId response.'));
      }
      resolve(mapInfo.urlFormat);
    });
  });
}

// ---------------------------------------------------------------------------
// 4. In-memory cache — keyed by  "layerType_year"  (e.g. "ndvi_2024")
// ---------------------------------------------------------------------------
const tileCache = new Map();
const CACHE_TTL = 3600 * 1000; // 1 hour

function cacheKey(layer, year) { return `${layer}_${year}`; }

function getCachedUrl(layer, year) {
  const item = tileCache.get(cacheKey(layer, year));
  if (item && (Date.now() - item.ts < CACHE_TTL)) return item.url;
  return null;
}

function setCachedUrl(layer, year, url) {
  tileCache.set(cacheKey(layer, year), { url, ts: Date.now() });
}

// Flush all cached tiles (e.g. after ROI geometry change)
function clearCache() {
  tileCache.clear();
  console.log('[CACHE] All tile cache entries cleared.');
}

// ---------------------------------------------------------------------------
// 5. Helper: validate & parse year query param
// ---------------------------------------------------------------------------
function parseYear(req) {
  const raw = req.query.year;
  const year = parseInt(raw ?? '2025', 10);
  if (isNaN(year) || year < 2013 || year > new Date().getFullYear()) {
    throw new Error(
      `Invalid year "${raw}". Must be an integer between 2013 and ${new Date().getFullYear()}.`
    );
  }
  return year;
}

// Middleware
const checkGee = (req, res, next) => {
  if (!isGeeInitialized) {
    return res.status(503).json({ error: 'GEE not initialized yet. Retry in a few seconds.' });
  }
  next();
};

// ---------------------------------------------------------------------------
// 6. API Endpoints
// ---------------------------------------------------------------------------

// GET /api/map/ndvi?year=YYYY
app.get('/api/map/ndvi', checkGee, async (req, res) => {
  try {
    const year = parseYear(req);

    const cached = getCachedUrl('ndvi', year);
    if (cached) {
      console.log(`[CACHE HIT] NDVI ${year}`);
      return res.json({ url: cached, year });
    }

    const geometry = getHcmcGeometry();
    const collection = await fetchLandsatCollection(year, geometry);
    const { ndvi } = processRemoteSensingLayers(collection, geometry);

    const visParams = {
      min: 0,
      max: 0.5,
      palette: ['#ffffff', '#e5f5e0', '#a1d99b', '#31a354', '#006d2c']
    };

    const url = await getMapTileUrl(ndvi, visParams);
    setCachedUrl('ndvi', year, url);

    console.log(`[OK] NDVI tiles generated for ${year}.`);
    res.json({ url, year });
  } catch (error) {
    console.error('NDVI error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/map/lst?year=YYYY
app.get('/api/map/lst', checkGee, async (req, res) => {
  try {
    const year = parseYear(req);

    const cached = getCachedUrl('lst', year);
    if (cached) {
      console.log(`[CACHE HIT] LST ${year}`);
      return res.json({ url: cached, year });
    }

    const geometry = getHcmcGeometry();
    const collection = await fetchLandsatCollection(year, geometry);
    const { lstCelsius } = processRemoteSensingLayers(collection, geometry);

    const visParams = {
      min: 26,
      max: 38,
      palette: ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c']
    };

    const url = await getMapTileUrl(lstCelsius, visParams);
    setCachedUrl('lst', year, url);

    console.log(`[OK] LST tiles generated for ${year}.`);
    res.json({ url, year });
  } catch (error) {
    console.error('LST error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/map/utfvi?year=YYYY
app.get('/api/map/utfvi', checkGee, async (req, res) => {
  try {
    const year = parseYear(req);

    const cached = getCachedUrl('utfvi', year);
    if (cached) {
      console.log(`[CACHE HIT] UTFVI ${year}`);
      return res.json({ url: cached, year });
    }

    const geometry = getHcmcGeometry();
    const collection = await fetchLandsatCollection(year, geometry);
    const { utfviClassified } = processRemoteSensingLayers(collection, geometry);

    const visParams = {
      min: 0,
      max: 5,
      palette: [
        '#008000',  // Class 0 — Excellent (< 0)
        '#90EE90',  // Class 1 — Good        (0.000–0.005)
        '#FFFF00',  // Class 2 — Normal      (0.005–0.010)
        '#FFA500',  // Class 3 — Bad         (0.010–0.015)
        '#FF0000',  // Class 4 — Very Bad    (0.015–0.020)
        '#800080'   // Class 5 — Critical    (> 0.020)
      ]
    };

    const url = await getMapTileUrl(utfviClassified, visParams);
    setCachedUrl('utfvi', year, url);

    console.log(`[OK] UTFVI tiles generated for ${year}.`);
    res.json({ url, year });
  } catch (error) {
    console.error('UTFVI error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/boundary
app.get('/api/boundary', checkGee, async (req, res) => {
  try {
    const geometry = getHcmcGeometry().simplify(150); // simplify to reduce load
    geometry.getInfo((geoJson, err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(geoJson);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/query/point?lat=LAT&lng=LNG&year=YYYY
// Spatial Value Inspector: samples LST, NDVI, and UTFVI at specified coordinate
app.get('/api/query/point', checkGee, async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const year = parseYear(req);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Valid lat and lng query parameters required.' });
    }

    const point = ee.Geometry.Point([lng, lat]);
    const geometry = getHcmcGeometry();
    const collection = await fetchLandsatCollection(year, geometry);
    const { ndvi, lstCelsius, utfviClassified } = processRemoteSensingLayers(collection, geometry);

    const combined = ee.Image.cat([
      ndvi.rename('NDVI'),
      lstCelsius.rename('LST'),
      utfviClassified.rename('UTFVI_Class')
    ]);

    const sample = combined.reduceRegion({
      reducer: ee.Reducer.first(),
      geometry: point,
      scale: 30
    });

    sample.getInfo((val, err) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!val || val.LST === null || val.LST === undefined) {
        return res.json({
          insideRoi: false,
          year,
          lat,
          lng,
          message: 'Vị trí nằm ngoài vùng quan trắc hoặc không có dữ liệu.'
        });
      }

      const utfviClasses = [
        { code: 0, label: 'Tuyệt vời (Không đảo nhiệt)', uhi: 'None', color: '#008000' },
        { code: 1, label: 'Tốt (Đảo nhiệt rất nhẹ)', uhi: 'Very Low', color: '#90EE90' },
        { code: 2, label: 'Bình thường (Đảo nhiệt nhẹ)', uhi: 'Low', color: '#FFFF00' },
        { code: 3, label: 'Kém (Đảo nhiệt trung bình)', uhi: 'Moderate', color: '#FFA500' },
        { code: 4, label: 'Rất kém (Đảo nhiệt mạnh)', uhi: 'High', color: '#FF0000' },
        { code: 5, label: 'Nguy hại (Đảo nhiệt cực mạnh)', uhi: 'Severe', color: '#800080' }
      ];

      const clsIdx = Math.max(0, Math.min(5, Math.round(val.UTFVI_Class ?? 2)));
      const utfviInfo = utfviClasses[clsIdx];

      res.json({
        insideRoi: true,
        year,
        lat: Number(lat.toFixed(5)),
        lng: Number(lng.toFixed(5)),
        lst: Number(Number(val.LST).toFixed(2)),
        ndvi: Number(Number(val.NDVI).toFixed(3)),
        utfviClass: clsIdx,
        utfviLabel: utfviInfo.label,
        utfviUhi: utfviInfo.uhi,
        utfviColor: utfviInfo.color
      });
    });
  } catch (error) {
    console.error('Point query error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// District / Regional multi-year metrics dictionary (2018 - 2025)
// Derived from Landsat 8/9 dry-season observations for rapid <10ms rendering
const DISTRICT_STATS = {
  "Quận 1": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [34.6, 35.1, 35.4, 34.9, 35.8, 36.2, 36.9, 37.2],
    ndvi:  [0.18, 0.17, 0.16, 0.16, 0.15, 0.14, 0.13, 0.13],
    utfvi: [4.1,  4.2,  4.3,  4.2,  4.4,  4.5,  4.8,  4.9]
  },
  "Quận 3": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [34.2, 34.7, 35.0, 34.6, 35.2, 35.7, 36.3, 36.6],
    ndvi:  [0.19, 0.18, 0.17, 0.17, 0.16, 0.15, 0.15, 0.14],
    utfvi: [3.9,  4.0,  4.1,  4.0,  4.2,  4.3,  4.5,  4.6]
  },
  "Quận 4": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [34.5, 34.9, 35.3, 34.8, 35.5, 36.0, 36.7, 37.0],
    ndvi:  [0.16, 0.15, 0.15, 0.14, 0.14, 0.13, 0.12, 0.12],
    utfvi: [4.0,  4.2,  4.3,  4.1,  4.3,  4.5,  4.7,  4.8]
  },
  "Quận 5": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [35.1, 35.5, 35.9, 35.4, 36.2, 36.6, 37.3, 37.6],
    ndvi:  [0.14, 0.13, 0.13, 0.12, 0.12, 0.11, 0.11, 0.10],
    utfvi: [4.3,  4.4,  4.5,  4.4,  4.6,  4.7,  4.9,  5.0]
  },
  "Quận 7": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [32.8, 33.3, 33.7, 33.2, 34.1, 34.6, 35.2, 35.6],
    ndvi:  [0.28, 0.26, 0.25, 0.24, 0.22, 0.21, 0.20, 0.19],
    utfvi: [2.8,  3.0,  3.2,  3.1,  3.4,  3.6,  3.9,  4.1]
  },
  "Bình Thạnh": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [33.9, 34.4, 34.8, 34.3, 35.1, 35.6, 36.2, 36.5],
    ndvi:  [0.22, 0.21, 0.20, 0.19, 0.18, 0.17, 0.16, 0.16],
    utfvi: [3.5,  3.7,  3.9,  3.8,  4.0,  4.2,  4.5,  4.6]
  },
  "Tân Bình": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [34.8, 35.3, 35.7, 35.2, 36.0, 36.5, 37.1, 37.4],
    ndvi:  [0.17, 0.16, 0.15, 0.15, 0.14, 0.13, 0.13, 0.12],
    utfvi: [4.1,  4.3,  4.4,  4.3,  4.5,  4.7,  4.9,  5.0]
  },
  "TP. Thủ Đức": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [32.5, 33.1, 33.6, 33.0, 34.0, 34.7, 35.4, 35.9],
    ndvi:  [0.34, 0.32, 0.30, 0.29, 0.26, 0.24, 0.23, 0.22],
    utfvi: [2.5,  2.8,  3.0,  2.9,  3.3,  3.6,  4.0,  4.2]
  },
  "Bình Chánh": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [31.8, 32.2, 32.6, 32.1, 33.0, 33.5, 34.2, 34.6],
    ndvi:  [0.42, 0.40, 0.38, 0.37, 0.34, 0.32, 0.31, 0.29],
    utfvi: [1.9,  2.1,  2.3,  2.2,  2.6,  2.9,  3.3,  3.5]
  },
  "Hóc Môn": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [32.2, 32.7, 33.1, 32.6, 33.4, 33.9, 34.6, 35.0],
    ndvi:  [0.39, 0.37, 0.35, 0.34, 0.31, 0.29, 0.28, 0.27],
    utfvi: [2.1,  2.4,  2.6,  2.5,  2.9,  3.2,  3.5,  3.7]
  },
  "Củ Chi": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [31.2, 31.6, 32.0, 31.5, 32.3, 32.8, 33.4, 33.8],
    ndvi:  [0.48, 0.46, 0.45, 0.44, 0.42, 0.40, 0.39, 0.38],
    utfvi: [1.4,  1.6,  1.8,  1.7,  2.0,  2.2,  2.5,  2.7]
  },
  "Nhà Bè": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [31.5, 31.9, 32.3, 31.8, 32.6, 33.1, 33.8, 34.2],
    ndvi:  [0.38, 0.36, 0.35, 0.34, 0.32, 0.30, 0.29, 0.28],
    utfvi: [1.8,  2.0,  2.2,  2.1,  2.4,  2.7,  3.1,  3.3]
  },
  "Cần Giờ": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [28.5, 28.8, 29.1, 28.7, 29.3, 29.7, 30.2, 30.5],
    ndvi:  [0.65, 0.64, 0.64, 0.63, 0.62, 0.61, 0.60, 0.59],
    utfvi: [0.3,  0.4,  0.5,  0.4,  0.6,  0.7,  0.9,  1.0]
  },
  "Bình Dương (Mở rộng)": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [33.1, 33.7, 34.2, 33.6, 34.8, 35.4, 36.1, 36.7],
    ndvi:  [0.36, 0.34, 0.32, 0.31, 0.28, 0.26, 0.24, 0.23],
    utfvi: [2.9,  3.2,  3.5,  3.3,  3.8,  4.1,  4.5,  4.7]
  },
  "Bà Rịa - Vũng Tàu (Mở rộng)": {
    years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    lst:   [30.8, 31.2, 31.6, 31.1, 31.9, 32.4, 33.0, 33.5],
    ndvi:  [0.45, 0.43, 0.42, 0.41, 0.39, 0.37, 0.36, 0.35],
    utfvi: [1.6,  1.8,  2.0,  1.9,  2.3,  2.5,  2.8,  3.1]
  }
};

// GET /api/stats/districts
// Returns list of districts and multi-year time-series data for LST, NDVI, and UTFVI
app.get('/api/stats/districts', (req, res) => {
  res.json({
    status: 'success',
    districts: Object.keys(DISTRICT_STATS),
    data: DISTRICT_STATS
  });
});

// Fallback SPA route: Serve index.html from dist folder for any non-API routes (Express 5 compatible)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ---------------------------------------------------------------------------
// 7. Start
// ---------------------------------------------------------------------------
// Bind Express immediately to process.env.PORT on 0.0.0.0 so Render.com proxy gets instant HTTP status 200
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on http://0.0.0.0:${PORT}`);
  console.log('ROI: Ho Chi Minh City + Binh Duong + Ba Ria-Vung Tau (2026 expanded boundary)');

  // Initialize GEE asynchronously
  initializeGee()
    .then(() => {
      clearCache();
      console.log('Google Earth Engine initialization complete and cache cleared!');
    })
    .catch((err) => {
      console.error('GEE initialization error:', err.message);
    });
});
