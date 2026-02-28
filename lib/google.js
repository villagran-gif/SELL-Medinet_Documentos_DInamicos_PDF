const { google } = require('googleapis');

function parseServiceAccountCredentials() {
  // Preferred: full JSON string
  const rawJson = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (rawJson) {
    const creds = JSON.parse(rawJson);
    if (creds.private_key && creds.private_key.includes('\\n')) {
      creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    }
    return creds;
  }

  // Back-compat: email + private key env vars
  const client_email = String(process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  let private_key = String(process.env.GOOGLE_PRIVATE_KEY || '').trim();
  if (private_key.includes('\\n')) private_key = private_key.replace(/\\n/g, '\n');
  if (!client_email || !private_key) {
    const err = new Error('Faltan credenciales Google: GOOGLE_SERVICE_ACCOUNT_JSON o GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY');
    err.code = 'MISSING_GOOGLE_CREDS';
    throw err;
  }

  return { client_email, private_key };
}

function getAuth() {
  const credentials = parseServiceAccountCredentials();
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
    ],
  });
}

function getDrive() {
  const auth = getAuth();
  return google.drive({ version: 'v3', auth });
}

function getDocs() {
  const auth = getAuth();
  return google.docs({ version: 'v1', auth });
}

module.exports = {
  getDrive,
  getDocs,
};
