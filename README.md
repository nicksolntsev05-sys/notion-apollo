# Notion → Apollo Email Enrichment

Сервис принимает webhook от кнопки в Notion, ищет email контакта через Apollo
по LinkedIn URL, и пишет email обратно в ту же строку Notion.

## Схема работы

```
[Кнопка в Notion] --webhook--> [этот сервер] --Apollo API--> email
                                      |
                                      +--Notion API--> запись email обратно
```

## 1. Настройка Notion

### 1.1 Создай Integration
1. Иди на https://www.notion.so/my-integrations → **New integration**
2. Название любое (например "Apollo Enrich")
3. Скопируй **Internal Integration Token** — это `NOTION_TOKEN`

### 1.2 Дай интеграции доступ к таблице
1. Открой свою таблицу в Notion
2. `•••` (в правом верхнем углу) → **Connections** → добавь свою интеграцию

### 1.3 Проверь свойства таблицы
- `Contact Linkedin page` — тип **URL** (важно! если сейчас Text — поменяй тип, иначе парсер в коде надо подправить)
- `Contacts Email` — тип **Email**
- Добавь новое свойство `Enrich Status` — тип **Text** (сервис будет писать туда "found" / "not_found" / "locked_needs_credits")
- Добавь свойство-кнопку, например `Enrich` — тип **Button**

## 2. Настройка Apollo

1. Apollo → Settings → **API** → скопируй API Key — это `APOLLO_API_KEY`
2. Нужен план Apollo с доступом к People Enrichment API (People Match endpoint)

## 3. Деплой на Railway

1. Залей эту папку в отдельный GitHub-репозиторий (или добавь как отдельный сервис в существующий Railway-проект)
2. В Railway: **New Service** → **Deploy from GitHub repo**
3. В Variables добавь все переменные из `.env.example`:
   - `NOTION_TOKEN`
   - `APOLLO_API_KEY`
   - `WEBHOOK_SECRET` — придумай длинную случайную строку (например через `openssl rand -hex 24`)
   - `NOTION_LINKEDIN_PROPERTY`, `NOTION_EMAIL_PROPERTY`, `NOTION_STATUS_PROPERTY` — если названия колонок отличаются от дефолтных, поменяй
4. Railway сам задеплоит и выдаст публичный URL, например:
   `https://notion-apollo-enrich-production.up.railway.app`

## 4. Настройка кнопки в Notion

1. Открой свойство `Enrich` (Button) → **Edit property**
2. **Add action** → **Send webhook**
3. URL:
   ```
   https://ТВОЙ-URL.up.railway.app/webhook/enrich?secret=ТВОЙ_WEBHOOK_SECRET
   ```
4. Notion спросит, какие свойства страницы отправлять в теле запроса — выбери
   как минимум `Contact Linkedin page` (и любые другие, если нужны).
5. Сохрани.

## 5. Тест

Нажми кнопку `Enrich` на любой строке с заполненным LinkedIn URL.
Через несколько секунд в `Contacts Email` должен появиться email
(или в `Enrich Status` — причина, почему не нашёлся).

Проверить логи — в Railway: Deployments → Logs.

### Ручной тест без Notion (curl)

```bash
curl -X POST "https://ТВОЙ-URL.up.railway.app/test/enrich?secret=ТВОЙ_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "linkedinUrl": "https://www.linkedin.com/in/example-person/",
    "pageId": "notion-page-id-сюда-если-хочешь-проверить-запись"
  }'
```

## Важные нюансы

- **Кредиты Apollo**: `reveal_personal_emails: false` в коде — экономит кредиты,
  берёт только рабочий (business) email, если он уже раскрыт в базе Apollo.
  Если нужен и личный email — поменяй на `true` в `src/server.js`, но это
  дороже по кредитам.
- **Email не найден**: если Apollo не знает email — в `Enrich Status`
  запишется `not_found` или `locked_needs_credits` (email есть, но платно
  раскрывать). Раскрытие email через `/people/match` тратит кредит **только
  если email действительно раскрывается** — сам поиск бесплатный.
- **Повторные клики**: сервис не проверяет, был ли email уже найден —
  просто перезапишет. Если хочешь экономить кредиты, можно добавить проверку
  "если Contacts Email уже заполнен — не дёргать Apollo снова" (скажи, добавлю).
