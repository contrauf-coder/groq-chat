// Прокси к Groq API для дневника питания, версия для Deno Deploy.
// Ключ и промпты живут только здесь: клиент выбирает режим, но не может подменить текст.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY');
const GROQ_MODEL = Deno.env.get('GROQ_MODEL') || 'llama-3.3-70b-versatile';
const ACCESS_CODE = Deno.env.get('ACCESS_CODE') || '';
const SYSTEM_PROMPT = Deno.env.get('SYSTEM_PROMPT') || '';

if (!GROQ_API_KEY) {
  console.error('GROQ_API_KEY не задан. Локально — в .env, на Deno Deploy — в настройках проекта');
  Deno.exit(1);
}

// Домены, которым разрешено обращаться к API из браузера (через запятую, без слеша на конце).
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Временно: ментальная карта открывается локально как file://, браузер шлёт Origin: null.
// Пускает к API любую локальную страницу — убрать, когда карта переедет на домен
// и её адрес попадёт в ALLOWED_ORIGINS.
if (!ALLOWED_ORIGINS.includes('null')) ALLOWED_ORIGINS.push('null');

// Режим для дневника питания: собеседник помогает пациенту описать съеденное.
const DIARY_PROMPT = `Ты — помощник в дневнике питания. Твоя задача — помочь человеку описать, что он сегодня ел, чтобы потом посчитать калории и БЖУ.

Как себя вести:
- Задавай короткие уточняющие вопросы о порциях, если человек их не указал. Не проси граммы первым делом: людям проще на глаз. Предложи померить как удобно и подскажи меру, подходящую именно этому блюду — ложки для каши, тарелка для супа, куски для хлеба, горсть для орехов, чашка для напитка. Граммы — лишь один из вариантов на выбор.
- Уточняй способ приготовления, если это влияет на калорийность (жареное/варёное, с маслом или без).
- Отвечай кратко, 1–3 предложения. Человек пишет с телефона.

Если человек говорит, что в этот приём пищи ничего не ел, — не уговаривай и не переспрашивай про порции. Подтверди коротко и сразу поставь [ГОТОВО].

Напитки — полноценный ответ, а не отсутствие ответа. Если человек пил только воду, чай или кофе, не требуй от него еду и никогда не говори, что записывать нечего. Уточни объём (стакан, кружка) и добавки — сахар, молоко, — и этого достаточно.

Когда узнал порции всего названного — не считай сразу. Сначала перечисли, что записал, и спроси, было ли что-то ещё.

Последней строкой ответа напиши ровно [ГОТОВО] — но только в одном из двух случаев:
- человек дал понять, что перечислил всё («всё», «это всё», «больше ничего», «посчитай»);
- он с самого начала описал приём пищи полностью и с порциями, так что спрашивать нечего.

На строке с маркером не должно быть ничего, кроме него. Не ставь [ГОТОВО], пока не знаешь порцию каждого продукта, и не ставь, если только что сам спросил «было ли что-то ещё» и ответа пока нет.

Чего делать нельзя:
- Не давай медицинских советов, не оценивай питание как хорошее или плохое, не рекомендуй диеты и не комментируй вес.
- Если спрашивают о здоровье, лечении или диете — скажи, что это вопрос к лечащему врачу, и вернись к описанию еды.`;

// Режим для ментальной карты: модель предлагает ответвления от выбранного узла.
// Клиент присылает карту целиком и помечает нужный узел, ответ разбирается построчно.
const MINDMAP_PROMPT = `Ты помогаешь развивать ментальную карту. Тебе дают карту целиком и один узел, помеченный стрелкой «←».

Предложи ответвления именно от помеченного узла: то, что логично раскрывает его тему на один уровень вглубь.

Ответ состоит из двух частей, разделённых отдельной строкой из трёх дефисов: ---

Первая часть — рассуждение в 2–4 предложениях: почему набор именно такой. Опирайся на карту: что у этого узла уже раскрыто, чего не хватает, какие напрашивающиеся варианты ты отбросил и почему. Пиши по делу, без вступлений вроде «Конечно» и без пересказа задания.

Вторая часть — список ответвлений:
- одно ответвление в строке;
- без нумерации, без дефисов, без кавычек, без пояснений до и после списка;
- от 4 до 6 строк;
- каждая строка — короткая формулировка до шести слов, с заглавной буквы, без точки в конце.

Чего избегать:
- не повторяй то, что уже есть в карте, даже другими словами;
- не уходи на уровень выше и не пересказывай сам узел;
- не пиши общие слова вроде «Разное» или «Прочие вопросы».

Форма ответа целиком (в угловых скобках — что подставить, сами скобки не пиши):
<рассуждение в 2–4 предложениях>
---
<ответвление>
<ответвление>
<ответвление>
<ответвление>

Строка из трёх дефисов должна быть в ответе ровно один раз, и после неё — только ответвления.
Каждое ответвление — осмысленная формулировка по теме узла. Не нумеруй их ни цифрами, ни словами
«первое», «второе»: это порядковые слова из образца, а не часть ответа.

Отвечай на языке карты.`;

const MODE_PROMPTS = {
  diary: DIARY_PROMPT,
  mindmap: MINDMAP_PROMPT,
};

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
- Напитки — такая же запись, как еда, и тоже попадают в items. Вода, чай и кофе без сахара
  и молока идут в items с нулями во всех числах: это не повод вернуть пустой список.
- Пустой items допустим только в двух случаях: человек ничего не ел и не пил (nothing: true)
  либо в диалоге не назван ни один продукт или напиток. Если названо хоть что-то — оно обязано
  попасть в items; при неизвестном объёме бери типичную порцию, а не пропускай.

Поле nothing ставь в true только тогда, когда человек не ел И не пил вообще ничего.
В этом случае верни пустой items и summary ровно "Ничего не ел".
Если он что-то пил — пусть даже одну воду — nothing: false, а напиток попадает в items.

Поле summary — это итоговая запись в дневник питания, одной фразой от первого лица.
В неё должны войти ВСЕ подробности, которые человек назвал за весь разговор, включая уточнённые не сразу:
количество и меру порции его словами (пять столовых ложек, средняя тарелка, два куска, одна штука),
способ приготовления, добавки и прямо названное их отсутствие.
Ничего не выбрасывай и не обобщай: «порция каши» вместо «пять столовых ложек каши» — ошибка.
Меру относи ровно к тому продукту, к которому отнёс её человек. Если он назвал количество отдельной
репликой в ответ на вопрос о главном блюде, оно относится к главному блюду, а не к добавке.
Когда непонятно, к чему относится количество, оставь его отдельной частью фразы, как сказал человек,
и не приписывай ни одному продукту.
Не добавляй своего: ни пересчитанных граммов, ни калорий, ни белков, жиров и углеводов. Числа в summary
допустимы только те, что назвал сам человек.
Пример: "Я ел рисовую кашу на молоке без сахара со сливочным маслом, пять полных столовых ложек."`;

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, x-access-code',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

// Простой rate limit по IP, чтобы случайный визитёр не сжёг лимиты API.
// Счётчик живёт в памяти изолята: Deploy держит их по регионам, так что лимит
// получается мягким — как и было на Render. Это заслон от случайностей, не защита.
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
function isAuthorized(request) {
  if (!ACCESS_CODE) return true;
  if (request.headers.get('x-access-code') === ACCESS_CODE) return true;
  const origin = request.headers.get('origin');
  // Origin: null подделывается одной строкой в curl, поэтому послаблением он не пользуется:
  // локальная ментальная карта присылает код заголовком, как чужой клиент.
  return Boolean(origin) && origin !== 'null' && ALLOWED_ORIGINS.includes(origin);
}

async function readMessages(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: 'Тело запроса должно быть корректным JSON' };
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return { error: 'Поле messages обязательно и должно быть непустым массивом' };
  }
  return { messages: body.messages, mode: body.mode };
}

async function callGroq(payload) {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model: GROQ_MODEL, ...payload }),
  });
  const data = await response.json();
  return { response, data };
}

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

async function handleChat(request, cors) {
  const { messages, mode, error } = await readMessages(request);
  if (error) return json({ error }, 400, cors);

  // mode выбирает серверный промпт; без него работает SYSTEM_PROMPT из настроек
  const systemPrompt = MODE_PROMPTS[mode] || SYSTEM_PROMPT;
  const fullMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const { response, data } = await callGroq({ messages: fullMessages });
  if (!response.ok) {
    console.error('Groq API error:', JSON.stringify(data));
    return json({ error: data.error?.message || 'Ошибка Groq API' }, response.status, cors);
  }

  return json({ reply: data.choices?.[0]?.message?.content ?? '' }, 200, cors);
}

async function handleSummary(request, cors) {
  const { messages, error } = await readMessages(request);
  if (error) return json({ error }, 400, cors);

  const { response, data } = await callGroq({
    messages: [{ role: 'system', content: SUMMARY_PROMPT }, ...messages],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  if (!response.ok) {
    console.error('Groq API error:', JSON.stringify(data));
    return json({ error: data.error?.message || 'Ошибка Groq API' }, response.status, cors);
  }

  const raw = data.choices?.[0]?.message?.content ?? '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Модель вернула не JSON:', raw);
    return json({ error: 'Не удалось разобрать ответ модели' }, 502, cors);
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

  return json(
    {
      ...totals,
      items,
      // Итоговая запись для дневника — её показывают врачу вместо цифр.
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      // Человек прямо сказал, что не ел: нулевой итог здесь законный, не ошибка разбора.
      nothing: parsed.nothing === true && items.length === 0,
      confident: parsed.confident === true && items.length > 0,
      note: typeof parsed.note === 'string' ? parsed.note : '',
    },
    200,
    cors
  );
}

async function handler(request, info) {
  const url = new URL(request.url);
  const cors = corsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Дешёвая проверка живости, без авторизации и лимитов: ответ не зависит от Groq.
  if (url.pathname === '/health') {
    return json({ ok: true }, 200, {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const isApi = url.pathname === '/api/chat' || url.pathname === '/api/nutrition-summary';
  if (!isApi) return json({ error: 'Не найдено' }, 404, cors);
  if (request.method !== 'POST') return json({ error: 'Ожидается POST' }, 405, cors);
  if (!isAuthorized(request)) return json({ error: 'Неверный код доступа' }, 401, cors);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    info?.remoteAddr?.hostname || 'unknown';
  if (isRateLimited(ip)) {
    return json({ error: 'Слишком много запросов, попробуйте позже' }, 429, cors);
  }

  try {
    return url.pathname === '/api/chat'
      ? await handleChat(request, cors)
      : await handleSummary(request, cors);
  } catch (err) {
    console.error('Ошибка запроса к Groq:', err);
    return json({ error: 'Не удалось связаться с Groq API' }, 502, cors);
  }
}

Deno.serve({ port: Number(Deno.env.get('PORT')) || 8000 }, handler);
