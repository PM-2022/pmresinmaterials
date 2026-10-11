/**
 * Uploads a review or beginner-guide image to Cloudflare R2.
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
 * Body JSON: { filename, contentType, dataBase64, folder }
 * Header: Authorization: Bearer <supabase access token>
 */
const crypto = require('crypto');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = 'https://ilxjsxinpxvifwtfqabc.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlseGpzeGlucHh2aWZ3dGZxYWJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyODg5NDksImV4cCI6MjA4OTg2NDk0OX0.2DUG3rdpSTtUORus-jBNWIiclnKj0RZNNVMzmJQsHHs';

function json(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors),
    body: JSON.stringify(body),
  };
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

async function putObject(env, key, body, contentType) {
  const host = env.accountId + '.r2.cloudflarestorage.com';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalUri = '/' + env.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
  const canonicalHeaders =
    'content-type:' + contentType + '\n' +
    'host:' + host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzDate + '\n';
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = dateStamp + '/auto/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + env.secret, dateStamp);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization =
    'AWS4-HMAC-SHA256 Credential=' + env.accessKey + '/' + credentialScope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  const res = await fetch('https://' + host + canonicalUri, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
    body: body,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || 'Cloudflare upload failed');
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const env = {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKey: process.env.R2_ACCESS_KEY_ID || '',
    secret: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || 'product-images',
    publicBase: (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  };
  if (!env.accountId || !env.accessKey || !env.secret || !env.publicBase) {
    return json(503, { error: 'Cloudflare R2 is not configured on the server yet.' });
  }

  const auth = String(event.headers.authorization || event.headers.Authorization || '');
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'Admin sign-in required.' });
  const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return json(401, { error: 'Admin sign-in required.' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid JSON' });
  }
  const folder = body.folder === 'guide' ? 'guide' : body.folder === 'reviews' ? 'reviews' : '';
  if (!folder) return json(400, { error: 'folder must be reviews or guide' });
  const bytes = Buffer.from(String(body.dataBase64 || ''), 'base64');
  if (!bytes.length || bytes.length > 1024 * 1024) {
    return json(400, { error: 'Image must be under 1 MB.' });
  }
  const ext = String(body.filename || 'photo.jpg').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const contentType = /^image\//.test(String(body.contentType || '')) ? String(body.contentType) : 'image/jpeg';
  const key = folder + '/' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  try {
    await putObject(env, key, bytes, contentType);
  } catch (err) {
    return json(502, { error: err.message || 'Cloudflare upload failed' });
  }
  return json(200, { url: env.publicBase + '/' + key });
};
