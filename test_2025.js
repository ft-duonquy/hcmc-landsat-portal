import ee from '@google/earthengine';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const clientEmail = process.env.VITE_EE_CLIENT_EMAIL;
const privateKey  = process.env.VITE_EE_PRIVATE_KEY?.replace(/\\n/g, '\n');

ee.data.setProject(process.env.VITE_EE_PROJECT_ID || clientEmail.split('@')[1].split('.iam.gserviceaccount.com')[0]);

ee.data.authenticateViaPrivateKey(
  { client_email: clientEmail, private_key: privateKey },
  () => {
    ee.initialize(null, null, () => {
      const geometry = ee.FeatureCollection('FAO/GAUL/2015/level2')
        .filter(ee.Filter.or(
          ee.Filter.eq('ADM1_NAME', 'Ho Chi Minh City'),
          ee.Filter.eq('ADM1_NAME', 'Binh Duong'),
          ee.Filter.eq('ADM1_NAME', 'Ba Ria-Vung Tau')
        )).geometry();

      ['2024', '2025'].forEach(year => {
        const startDate = `${year}-01-01`;
        const endDate   = `${year}-05-31`;

        const l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
          .filterBounds(geometry)
          .filterDate(startDate, endDate)
          .filter(ee.Filter.lt('CLOUD_COVER', 70));

        const l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
          .filterBounds(geometry)
          .filterDate(startDate, endDate)
          .filter(ee.Filter.lt('CLOUD_COVER', 70));

        const col = l8.merge(l9);
        col.size().evaluate((size, err) => {
          if (err) console.error(`Error ${year}:`, err);
          else console.log(`Year ${year} dry season scenes count:`, size);
        });
      });
    });
  }
);
