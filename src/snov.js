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

// ---- LinkedIn profile enrichment (имя, компания, позиция — БЕЗ email) ----

async function startLinkedInEnrichment(linkedinUrl, token) {
  const params = new URLSearchParams();
  params.append('urls[]', linkedinUrl);

  const res = await fetch(`https://api.snov.io/v2/li-profiles-by-urls/start?${params.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Snov.io enrichment start failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function getEnrichmentResult(taskHash, token) {
  const params = new URLSearchParams({ task_hash: taskHash });

  const res = await fetch(
    `https://api.snov.io/v2/li-profiles-by-urls/result?${params.toString()}`,
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
    if (result.status === 'completed') {
      return result;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Snov.io task did not complete in time');
}

// ---- Email Finder (имя + домен -> email) ----

async function startEmailFinder(firstName, lastName, domain, token) {
  const res = await fetch('https://api.snov.io/v2/emails-by-domain-by-name/start', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      rows: [{ first_name: firstName, last_name: lastName, domain }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Snov.io email finder start failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function getEmailFinderResult(taskHash, token) {
  const params = new URLSearchParams({ task_hash: taskHash });
  const res = await fetch(
    `https://api.snov.io/v2/emails-by-domain-by-name/result?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Snov.io email finder result failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function pollEmailFinderResult(taskHash, token, maxTries = 10, delayMs = 3000) {
  for (let i = 0; i < maxTries; i++) {
    const result = await getEmailFinderResult(taskHash, token);
    console.log(`[Snov] email finder poll attempt ${i + 1}:`, JSON.stringify(result));

    if (result.status === 'completed') return result;
    if (result.status === 'failed' || result.errors) {
      throw new Error(`Snov.io email finder task failed: ${JSON.stringify(result)}`);
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Snov.io email finder task did not complete in time');
}

module.exports = {
  getSnovToken,
  startLinkedInEnrichment,
  pollEnrichmentResult,
  startEmailFinder,
  pollEmailFinderResult,
};
