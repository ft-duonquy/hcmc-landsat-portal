import { APP_CONFIG } from './config.js';

// Lưu ý: Đối tượng `ee` cần được xác thực (authenticate) và khởi tạo (initialize)
// thông qua thư viện @google/earthengine trước khi gọi các hàm này trên web.

export function getRegion(ee) {
  return ee.Geometry.Point(APP_CONFIG.REGION_COORDS).buffer(APP_CONFIG.BUFFER_SIZE);
}

export function getLandsatDataset(ee, region) {
  return ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .filterBounds(region)
    .filterDate(APP_CONFIG.START_DATE, APP_CONFIG.END_DATE)
    .sort('CLOUD_COVER')
    .first()
    .clip(region);
}

export function calculateNDVI(dataset) {
  return dataset.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');
}

export function calculateLST(dataset) {
  const thermal = dataset.select('ST_B10');
  return thermal.multiply(0.00341802).add(149.0).subtract(273.15).rename('LST');
}

export function calculateMeanLST(ee, lstImage, region) {
  return lstImage.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: region,
    scale: 30
  });
}
