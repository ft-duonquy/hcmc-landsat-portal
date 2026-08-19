import { GoogleAuth } from 'google-auth-library';

export default async function handler(req, res) {
  try {
    const credentials = {
      client_email: process.env.VITE_EE_CLIENT_EMAIL,
      private_key: process.env.VITE_EE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    };

    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/earthengine', 'https://www.googleapis.com/auth/devstorage.full_control']
    });

    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();

    // Lấy Project ID từ biến môi trường VITE_EE_PROJECT_ID hoặc trích xuất từ email của Service Account
    const projectId = process.env.VITE_EE_PROJECT_ID || credentials.client_email.split('@')[1].split('.iam.gserviceaccount.com')[0];

    res.status(200).json({ token: tokenResponse.token, projectId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
