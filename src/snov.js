let cachedToken = null;
let tokenExpiresAt = 0;

async function getSnovToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.SNOV_CLIENT_ID,
      client_secret: process.env.SNOV_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Snov.io auth failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return cachedToken;
}

async function startLinkedInEnrichment(linkedinUrl, token) {
  const res = await fetch('https://api.snov.io/v2/linkedin-url-enrichment/start', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ urls: [linkedinUrl] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Snov.io enrichment start failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function getEnrichmentResult(taskHash, token) {
  const res = await fetch(
    `https://api.snov.io/v2/linkedin-url-enrichment/result?task_hash=${taskHash}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Snov.io result fetch failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function pollEnrichmentResult(taskHash, token, maxTries = 10, delayMs = 2000) {
  for (let i = 0; i < maxTries; i++) {
    const result = await getEnrichmentResult(taskHash, token);
    if (result.status === 'completed' || result.data) {
      return result;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Snov.io task did not complete in time');
}

module.exports = {
  getSnovToken,
  startLinkedInEnrichment,
  pollEnrichmentResult,
};
