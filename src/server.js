require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const { getSnovToken, startLinkedInEnrichment, pollEnrichmentResult } = require('./snov');

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
  NOTION_LINKEDIN_PROPERTY = 'Contact Linkedin page',
  NOTION_EMAIL_PROPERTY = 'Contacts Email',
  NOTION_STATUS_PROPERTY = 'Enrich Status', // необязательное текстовое поле-статус
} = process.env;

if (!NOTION_TOKEN || !APOLLO_API_KEY || !WEBHOOK_SECRET) {
  console.error('Missing required env vars: NOTION_TOKEN, APOLLO_API_KEY, WEBHOOK_SECRET');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// ---------- Хелперы ----------

// Достаём LinkedIn URL и page_id из тела вебхука Notion.
// Notion присылает данные о странице/свойствах в разных формах в зависимости от того,
// как настроена кнопка (data.id + data.properties, либо просто id + properties).
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
      reveal_personal_emails: false, // включи true, если нужен личный email (тратит доп. кредиты)
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
  const startResp = await startLinkedInEnrichment(linkedinUrl, token);
  const result = await pollEnrichmentResult(startResp.task_hash, token);

  // На первом реальном тесте залогируй полный ответ, чтобы свериться со структурой:
  console.log('Snov.io raw result:', JSON.stringify(result));

  const person = result.data?.[0];
  if (!person || !person.emails?.length) {
    return { email: null, status: 'not_found' };
  }

  return { email: person.emails[0], status: 'found' };
}

async function updateNotionPage(pageId, email, status) {
  const properties = {};

  if (email) {
    properties[NOTION_EMAIL_PROPERTY] = {
      email: email, // если колонка Contacts Email — тип Email
    };
  }

  if (NOTION_STATUS_PROPERTY) {
    properties[NOTION_STATUS_PROPERTY] = {
      rich_text: [{ text: { content: status } }],
    };
  }

  await notion.pages.update({
    page_id: pageId,
    properties,
  });
}

// ---------- Роуты ----------

// Основной вебхук — на него будет бить кнопка Notion
app.post('/webhook/enrich', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Отвечаем Notion сразу, чтобы не ждал — дальше обрабатываем асинхронно
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

// Тестовый эндпоинт — чтобы проверить руками через curl, без Notion (Apollo)
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

// Тестовый эндпоинт для Snov.io — отдельно от Apollo, ничего не ломает
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
