import ee from '@google/earthengine';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const clientEmail = process.env.VITE_EE_CLIENT_EMAIL;
const privateKey  = process.env.VITE_EE_PRIVATE_KEY?.replace(/\\n/g, '\n');

const projectId = process.env.VITE_EE_PROJECT_ID || clientEmail.split('@')[1].split('.iam.gserviceaccount.com')[0];
ee.data.setProject(projectId);

ee.data.authenticateViaPrivateKey(
  { client_email: clientEmail, private_key: privateKey },
  () => {
    ee.initialize(null, null, () => {
      const collection = ee.FeatureCollection('FAO/GAUL/2015/level2')
        .filter(ee.Filter.or(
          ee.Filter.eq('ADM1_NAME', 'Ho Chi Minh City'),
          ee.Filter.eq('ADM1_NAME', 'Binh Duong'),
          ee.Filter.eq('ADM1_NAME', 'Ba Ria-Vung Tau')
        ));
      
      const unionGeom = collection.union().geometry();
      
      unionGeom.evaluate((result, err) => {
        if (err) {
          console.error('Union failed:', err);
        } else {
          console.log('Union succeeded, type:', result.type);
        }
        process.exit(0);
      });
    });
  },
  (err) => {
    console.error('Auth error:', err);
    process.exit(1);
  }
);
