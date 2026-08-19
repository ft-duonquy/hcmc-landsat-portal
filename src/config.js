export const APP_CONFIG = {
  REGION_COORDS: [106.7091, 10.7578],
  BUFFER_SIZE: 2500,
  START_DATE: '2023-01-01',
  END_DATE: '2023-12-31',
};

export const VISUALIZATION = {
  TRUE_COLOR: {
    bands: ['SR_B4', 'SR_B3', 'SR_B2'],
    min: 0,
    max: 30000,
  },
  NDVI: {
    min: 0,
    max: 0.5,
    palette: ['white', 'green'],
  },
  LST: {
    min: 25,
    max: 45,
    palette: ['blue', 'yellow', 'red'],
  }
};
