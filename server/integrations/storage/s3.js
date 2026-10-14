import crypto from 'node:crypto';

// Uploads a file to S3-compatible object storage (Oracle Object Storage,
// Cloudflare R2, Backblaze B2, AWS S3 …) with AWS Signature Version 4.
// Path-style URLs: {endpoint}/{bucket}/{key}.

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

export function signRequest({ method, url, headers, body, region, accessKey, secretKey, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261014T101500Z
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? '');
  const all = { ...headers, host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [method, url.pathname, url.searchParams.toString(), ...names.map((n) => `${n}:${lower[n]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...lower,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

export async function putObject({ endpoint, region, bucket, accessKey, secretKey }, key, body, contentType = 'application/octet-stream') {
  const url = new URL(`${endpoint}/${encodeURIComponent(bucket)}/${encodeKey(key)}`);
  const headers = signRequest({ method: 'PUT', url, headers: { 'content-type': contentType }, body, region, accessKey, secretKey });
  delete headers.host;
  let response;
  try {
    response = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new Error(`Could not reach the backup storage: ${err.message}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const reason = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? text.slice(0, 200);
    throw new Error(`Backup storage returned ${response.status}${reason ? `: ${reason}` : ''}`);
  }
  return { key, etag: response.headers.get('etag') };
}
