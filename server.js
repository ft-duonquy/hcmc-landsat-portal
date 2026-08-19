import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import ee from '@google/earthengine';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env.local (or system environment in production)
dotenv.config({ path: '.env.local' });

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files from 'dist' directory when deployed
app.use(express.static(path.join(__dirname, 'dist')));

const PORT = process.env.PORT || 5000;

const clientEmail = process.env.VITE_EE_CLIENT_EMAIL;
const privateKey  = process.env.VITE_EE_PRIVATE_KEY?.replace(/\\n/g, '\n');

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
  return ee.FeatureCollection('FAO/GAUL/2015/level2')
    .filter(ee.Filter.or(
      ee.Filter.eq('ADM1_NAME', 'Ho Chi Minh City'),
      ee.Filter.eq('ADM1_NAME', 'Binh Duong'),
      ee.Filter.eq('ADM1_NAME', 'Ba Ria-Vung Tau')
    ))
    .geometry();
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
  const cirrusBit       = 1 << 2;
  const cloudShadowBit  = 1 << 3;
  const cloudBit        = 1 << 4;
  
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
      const endDate   = `${year}-05-31`;

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
  const ndviFocal   = ndviMeanRaw.focal_mean({ radius: 10, kernelType: 'circle', units: 'pixels' });
  const ndvi        = ndviMeanRaw.unmask(ndviFocal).unmask(0.25).rename('NDVI').clip(geometry);

  // B. NDWI Water & Intertidal Mudflat Masking
  const ndwiMeanRaw = collection.select('NDWI').mean();
  const isWater     = ndwiMeanRaw.gt(0.02); // Detect open water, shallow aquaculture, and intertidal mudflats

  // C. LST calculation: Use 85th Percentile during dry season to capture PEAK heat spikes (rubber defoliation & urban concrete)
  const lstPeakRaw  = collection.select('LST_Celsius').reduce(ee.Reducer.percentile([85])).rename('LST_Celsius');
  const lstFocal    = lstPeakRaw.focal_mean({ radius: 10, kernelType: 'circle', units: 'pixels' });
  const lstFilled   = lstPeakRaw.unmask(lstFocal).unmask(30.0);

  // Apply NDWI water mask: Water bodies & Can Gio intertidal mangrove waters get cool temperature (~26.5°C)
  const lstCelsius  = lstFilled.where(isWater, 26.5).rename('LST_Celsius').clip(geometry);

  // D. UTFVI calculation (Derived from gap-free lstCelsius)
  const lstKelvin = lstCelsius.add(273.15).rename('LST_Kelvin');

  const meanDict = lstKelvin.reduceRegion({
    reducer:   ee.Reducer.mean(),
    geometry:  geometry,
    scale:     30,
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
    if (Array.isArray(val))           formatted[key] = val.join(',');
    else if (typeof val === 'number') formatted[key] = String(val);
    else                              formatted[key] = val;
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
const tileCache  = new Map();
const CACHE_TTL  = 3600 * 1000; // 1 hour

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
  const raw  = req.query.year;
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

    const geometry   = getHcmcGeometry();
    const collection = await fetchLandsatCollection(year, geometry);
    const { ndvi }   = processRemoteSensingLayers(collection, geometry);

    const visParams = {
      min:     0,
      max:     0.5,
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

    const geometry       = getHcmcGeometry();
    const collection     = await fetchLandsatCollection(year, geometry);
    const { lstCelsius } = processRemoteSensingLayers(collection, geometry);

    const visParams = {
      min:     26,
      max:     38,
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

    const geometry            = getHcmcGeometry();
    const collection          = await fetchLandsatCollection(year, geometry);
    const { utfviClassified } = processRemoteSensingLayers(collection, geometry);

    const visParams = {
      min:     0,
      max:     5,
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

// Fallback SPA route: Serve index.html from dist folder for any non-API routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ---------------------------------------------------------------------------
// 7. Start
// ---------------------------------------------------------------------------
initializeGee()
  .then(() => {
    // Flush stale cache on startup so the new 3-province mosaic is computed fresh
    clearCache();
    app.listen(PORT, () => {
      console.log(`Backend server running on http://localhost:${PORT}`);
      console.log('ROI: Ho Chi Minh City + Binh Duong + Ba Ria-Vung Tau (2026 expanded boundary)');
    });
  })
  .catch((err) => {
    console.error('Fatal: GEE initialization failed. Server cannot start.', err);
    process.exit(1);
  });
