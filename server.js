const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '';

if (!GROQ_API_KEY) {
  console.error('GROQ_API_KEY не задан. Создайте .env на основе .env.example');
  process.exit(1);
}

// Режим для дневника питания: собеседник помогает пациенту описать съеденное.
// Промпты задаются только на сервере — клиент может выбрать режим, но не подменить текст.
const DIARY_PROMPT = `Ты — помощник в дневнике питания. Твоя задача — помочь человеку описать, что он сегодня ел, чтобы потом посчитать калории и БЖУ.

Как себя вести:
- Задавай короткие уточняющие вопросы о порциях, если человек их не указал (сколько грамм, штук, ложек).
- Уточняй способ приготовления, если это влияет на калорийность (жареное/варёное, с маслом или без).
- Отвечай кратко, 1–3 предложения. Человек пишет с телефона.

Если человек говорит, что в этот приём пищи ничего не ел, — не уговаривай и не переспрашивай про порции. Подтверди коротко и сразу поставь [ГОТОВО].

Когда узнал порции всего названного — не считай сразу. Сначала перечисли, что записал, и спроси, было ли что-то ещё.

Последней строкой ответа напиши ровно [ГОТОВО] — но только в одном из двух случаев:
- человек дал понять, что перечислил всё («всё», «это всё», «больше ничего», «посчитай»);
- он с самого начала описал приём пищи полностью и с порциями, так что спрашивать нечего.

На строке с маркером не должно быть ничего, кроме него. Не ставь [ГОТОВО], пока не знаешь порцию каждого продукта, и не ставь, если только что сам спросил «было ли что-то ещё» и ответа пока нет.

Чего делать нельзя:
- Не давай медицинских советов, не оценивай питание как хорошее или плохое, не рекомендуй диеты и не комментируй вес.
- Если спрашивают о здоровье, лечении или диете — скажи, что это вопрос к лечащему врачу, и вернись к описанию еды.`;

const MODE_PROMPTS = {
  diary: DIARY_PROMPT,
};

app.use(express.json({ limit: '1mb' }));

// Разрешаем запросы с доменов, перечисленных в ALLOWED_ORIGINS (через запятую).
// Нужно, чтобы приложение с другого домена могло обращаться к этому API.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-access-code');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Дешёвая проверка живости. Нужна, чтобы будить сервис на бесплатном Render
// (он засыпает после ~15 минут простоя). Без авторизации и без rate limit:
// ответ не зависит от Groq и ничего не стоит.
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.use(express.static(path.join(__dirname, 'public')));

// Простой rate limit по IP, чтобы случайный визитёр не сжёг лимиты API
const RATE_LIMIT = 20; // запросов
const RATE_WINDOW_MS = 60 * 1000; // за минуту
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

// Код доступа нужен для чужих клиентов. Запросы со своих доменов (ALLOWED_ORIGINS)
// пропускаем без него — иначе код пришлось бы зашить в открытый код страницы,
// где он всё равно перестал бы быть секретом.
function isAuthorized(req) {
  if (!ACCESS_CODE) return true;
  if (req.get('x-access-code') === ACCESS_CODE) return true;
  const origin = req.get('origin');
  return Boolean(origin) && ALLOWED_ORIGINS.includes(origin);
}

app.post('/api/chat', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Неверный код доступа' });
  }

  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Поле messages обязательно и должно быть непустым массивом' });
  }

  // mode выбирает серверный промпт; без него работает прежний SYSTEM_PROMPT из .env
  const systemPrompt = MODE_PROMPTS[req.body.mode] || SYSTEM_PROMPT;
  const fullMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: fullMessages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Groq API error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'Ошибка Groq API' });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    res.json({ reply });
  } catch (err) {
    console.error('Ошибка запроса к Groq:', err);
    res.status(502).json({ error: 'Не удалось связаться с Groq API' });
  }
});

// Подсчёт итогов по диалогу: модель обязана вернуть строго JSON, а не текст.
// Разбивка по продуктам обязательна — без неё модель склонна возвращать нули.
const SUMMARY_PROMPT = `Ты — анализатор питания. По диалогу ниже посчитай калории и БЖУ.

Сначала распиши КАЖДЫЙ упомянутый продукт отдельно с его весом и пищевой ценностью, затем сложи.

Отвечай СТРОГО одним JSON-объектом, без markdown и без пояснений вне JSON:
{"items": [{"name": "название", "grams": число, "calories": число, "protein": число, "fat": число, "carbs": число}], "summary": "строка", "nothing": true или false, "confident": true или false, "note": "краткий комментарий на русском"}

Правила:
- Считай по стандартным таблицам пищевой ценности продуктов.
- calories в ккал, protein/fat/carbs в граммах, все числа целые и неотрицательные.
- Если вес указан — обязательно посчитай, отказываться нельзя.
- Если вес не указан, возьми типичную порцию и посчитай всё равно.
- confident: false ставь только если продукты вообще не названы.
- Если еда не упоминалась совсем, верни пустой items и confident: false.

Поле nothing ставь в true только тогда, когда из диалога прямо следует, что человек в этот приём пищи НИЧЕГО не ел.
В этом случае верни пустой items и summary ровно "Ничего не ел".
Во всех остальных случаях nothing: false.

Поле summary — это итоговая запись в дневник питания, одной фразой от первого лица.
В неё должны войти ВСЕ подробности, которые человек назвал за весь разговор, включая уточнённые не сразу:
количество и меру порции его словами (пять столовых ложек, средняя тарелка, два куска, одна штука),
способ приготовления, добавки и прямо названное их отсутствие.
Ничего не выбрасывай и не обобщай: «порция каши» вместо «пять столовых ложек каши» — ошибка.
Не добавляй своего: ни пересчитанных граммов, ни калорий, ни белков, жиров и углеводов. Числа в summary
допустимы только те, что назвал сам человек.
Пример: "Я ел рисовую кашу на молоке без сахара со сливочным маслом, пять полных столовых ложек."`;

function toNonNegativeInt(value) {
  const num = Math.round(Number(value));
  return Number.isFinite(num) && num > 0 ? num : 0;
}

// Сумму считаем сами: арифметике модели доверять нельзя.
function sumItems(items) {
  const totals = { calories: 0, protein: 0, fat: 0, carbs: 0 };
  if (!Array.isArray(items)) return totals;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    totals.calories += toNonNegativeInt(item.calories);
    totals.protein += toNonNegativeInt(item.protein);
    totals.fat += toNonNegativeInt(item.fat);
    totals.carbs += toNonNegativeInt(item.carbs);
  }
  return totals;
}

app.post('/api/nutrition-summary', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Неверный код доступа' });
  }

  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Поле messages обязательно и должно быть непустым массивом' });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'system', content: SUMMARY_PROMPT }, ...messages],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Groq API error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'Ошибка Groq API' });
    }

    const raw = data.choices?.[0]?.message?.content ?? '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('Модель вернула не JSON:', raw);
      return res.status(502).json({ error: 'Не удалось разобрать ответ модели' });
    }

    const totals = sumItems(parsed.items);
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            name: typeof item.name === 'string' ? item.name : 'продукт',
            grams: toNonNegativeInt(item.grams),
            calories: toNonNegativeInt(item.calories),
            protein: toNonNegativeInt(item.protein),
            fat: toNonNegativeInt(item.fat),
            carbs: toNonNegativeInt(item.carbs),
          }))
      : [];

    res.json({
      ...totals,
      items,
      // Итоговая запись для дневника — её показывают врачу вместо цифр.
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      // Человек прямо сказал, что не ел: нулевой итог здесь законный, не ошибка разбора.
      nothing: parsed.nothing === true && items.length === 0,
      confident: parsed.confident === true && items.length > 0,
      note: typeof parsed.note === 'string' ? parsed.note : '',
    });
  } catch (err) {
    console.error('Ошибка запроса к Groq:', err);
    res.status(502).json({ error: 'Не удалось связаться с Groq API' });
  }
});

app.listen(PORT, () => {
  console.log(`Счётчик калорий запущен: http://localhost:${PORT}`);
});
