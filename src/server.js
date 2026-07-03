require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const {
  getSnovToken,
  startLinkedInEnrichment,
  pollEnrichmentResult,
  startEmailFinder,
  pollEmailFinderResult,
} = require('./snov');

const app = express();
app.use(express.json());

// ---- ENV VARS (задаются в Railway) ----
const {
  PORT = 3000,
  NOTION_TOKEN,          // secret_xxx / ntn_xxx
  APOLLO_API_KEY,
  SNOV_CLIENT_ID,
  SNOV_CLIENT_SECRET,
  WEBHOOK_SECRET,        // произвольная строка, которую мы сами придумаем — для защиты эндпоинта
  NOTION_LINKEDIN_PROPERTY = 'LinkedIn',
  NOTION_EMAIL_PROPERTY = 'Emails',
  NOTION_STATUS_PROPERTY = '', // необязательное текстовое поле-статус; пусто = не отправлять
} = process.env;

if (!NOTION_TOKEN || !APOLLO_API_KEY || !WEBHOOK_SECRET) {
  console.error('Missing required env vars: NOTION_TOKEN, APOLLO_API_KEY, WEBHOOK_SECRET');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// ---------- Хелперы ----------

// Достаём LinkedIn URL и page_id из тела вебхука Notion.
function extractFromNotionPayload(body) {
  const page = body.data || body;
  const pageId = page.id;
  const props = page.properties || {};

  const linkedinProp = props[NOTION_LINKEDIN_PROPERTY];
  let linkedinUrl = null;

  if (linkedinProp) {
    if (linkedinProp.type === 'url') linkedinUrl = linkedinProp.url;
    else if (linkedinProp.url) linkedinUrl = linkedinProp.url;
    else if (linkedinProp.rich_text?.length) {
      linkedinUrl = linkedinProp.rich_text.map((t) => t.plain_text).join('');
    } else if (linkedinProp.title?.length) {
      linkedinUrl = linkedinProp.title.map((t) => t.plain_text).join('');
    }
  }

  return { pageId, linkedinUrl };
}

function extractDomain(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function findEmailViaApollo(linkedinUrl) {
  const resp = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': APOLLO_API_KEY,
    },
    body: JSON.stringify({
      linkedin_url: linkedinUrl,
      reveal_personal_emails: false,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Apollo API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const person = data.person;
  if (!person) return { email: null, status: 'not_found' };

  if (person.email && person.email !== 'email_not_unlocked@domain.com') {
    return { email: person.email, status: 'found' };
  }
  if (person.email_status === 'locked') {
    return { email: null, status: 'locked_needs_credits' };
  }
  return { email: null, status: 'not_found' };
}

async function findEmailViaSnov(linkedinUrl) {
  const token = await getSnovToken();

  // Шаг 1: получаем профиль (имя, домен компании из первой позиции)
  const startResp = await startLinkedInEnrichment(linkedinUrl, token);
  const taskHash = startResp.data?.task_hash;
  if (!taskHash) throw new Error('No task_hash in Snov.io profile response');

  const profileResult = await pollEnrichmentResult(taskHash, token);
  console.log('[Snov] profile result:', JSON.stringify(profileResult));

  const entry = profileResult.data?.[0];
  const person = entry?.result;
  if (!person || Array.isArray(person)) {
    return { email: null, status: 'profile_not_found' };
  }

  const firstName = person.first_name;
  const lastName = person.last_name;
  const companyUrl = person.positions?.[0]?.url;
  const domain = extractDomain(companyUrl);

  if (!firstName || !lastName || !domain) {
    console.log('[Snov] Not enough data for email finder:', { firstName, lastName, domain });
    return { email: null, status: 'missing_name_or_domain' };
  }

   // Шаг 2: ищем email по имени+домену
  const finderStart = await startEmailFinder(firstName, lastName, domain, token);
  console.log('[Snov] email finder start response:', JSON.stringify(finderStart));

  const finderTaskHash = finderStart.data?.task_hash;
  if (!finderTaskHash) throw new Error('No task_hash in Snov.io email finder response');

  const finderResult = await pollEmailFinderResult(finderTaskHash, token);
  console.log('[Snov] email finder result:', JSON.stringify(finderResult));

  const foundEmail =
    finderResult.data?.[0]?.emails?.[0]?.email ||
    finderResult.data?.[0]?.email ||
    null;

  if (!foundEmail) {
    return { email: null, status: 'not_found' };
  }

  return { email: foundEmail, status: 'found' };
}

async function updateNotionPage(pageId, email, status) {
  const properties = {};

  if (email) {
    properties[NOTION_EMAIL_PROPERTY] = {
      email: email,
    };
  }

  if (NOTION_STATUS_PROPERTY) {
    properties[NOTION_STATUS_PROPERTY] = {
      rich_text: [{ text: { content: status } }],
    };
  }

  if (Object.keys(properties).length === 0) return;

  try {
    await notion.pages.update({
      page_id: pageId,
      properties,
    });
  } catch (err) {
    if (err.code === 'validation_error') {
      console.error(`Notion validation error (проверь названия/типы колонок): ${err.message}`);
      // фолбэк — пробуем записать только email, без статуса
      if (email && NOTION_STATUS_PROPERTY) {
        try {
          await notion.pages.update({
            page_id: pageId,
            properties: { [NOTION_EMAIL_PROPERTY]: { email } },
          });
        } catch (innerErr) {
          console.error('Notion fallback update also failed:', innerErr.message);
        }
      }
    } else {
      throw err;
    }
  }
}

// ---------- Роуты ----------

// Основной вебхук — на него будет бить кнопка Notion (Apollo)
app.post('/webhook/enrich', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  res.status(200).json({ ok: true, received: true });

  try {
    const { pageId, linkedinUrl } = extractFromNotionPayload(req.body);

    if (!pageId || !linkedinUrl) {
      console.error('Missing pageId or linkedinUrl in payload', req.body);
      return;
    }

    console.log(`Enriching page ${pageId} via LinkedIn: ${linkedinUrl}`);

    const { email, status } = await findEmailViaApollo(linkedinUrl);
    await updateNotionPage(pageId, email, status);

    console.log(`Done. Page ${pageId} -> status: ${status}, email: ${email || 'none'}`);
  } catch (err) {
    console.error('Enrichment failed:', err.message);
  }
});

// Тестовый вебхук для Notion — Snov.io
app.post('/webhook/enrich-snov', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  res.status(200).json({ ok: true, received: true });

  try {
    const { pageId, linkedinUrl } = extractFromNotionPayload(req.body);

    if (!pageId || !linkedinUrl) {
      console.error('Missing pageId or linkedinUrl in payload', JSON.stringify(req.body));
      return;
    }

    console.log(`[Snov] Enriching page ${pageId} via LinkedIn: ${linkedinUrl}`);

    const { email, status } = await findEmailViaSnov(linkedinUrl);
    await updateNotionPage(pageId, email, status);

    console.log(`[Snov] Done. Page ${pageId} -> status: ${status}, email: ${email || 'none'}`);
  } catch (err) {
    console.error('[Snov] Enrichment failed:', err.message);
  }
});

// Тестовый эндпоинт — Apollo, без Notion
app.post('/test/enrich', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { pageId, linkedinUrl } = req.body;
    const { email, status } = await findEmailViaApollo(linkedinUrl);
    if (pageId) await updateNotionPage(pageId, email, status);
    res.json({ email, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Тестовый эндпоинт для Snov.io — без Notion
app.post('/test/enrich-snov', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { pageId, linkedinUrl } = req.body;
    if (!linkedinUrl) {
      return res.status(400).json({ error: 'linkedinUrl is required' });
    }
    const { email, status } = await findEmailViaSnov(linkedinUrl);
    if (pageId) await updateNotionPage(pageId, email, status);
    res.json({ email, status });
  } catch (err) {
    console.error('Snov test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
