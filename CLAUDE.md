# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

iPromotion (antes iBenefits) rastrea (crawl) las ofertas semanales de supermercados (Tokmanni, K-Ruoka, Prisma, S-market, Lidl),
tiendas de ropa (XXL, Intersport, Stadium, KappAhl, New Yorker) y electrónica (Power,
Verkkokauppa.com, Gigantti) y belleza/farmacia (KICKS, Yliopiston Apteekki) de la zona de Oulu, y las muestra en una sola web con filtros.
Node.js (ESM, `"type": "module"`), Express 5, node-cron, cheerio y Playwright (Chromium).
Sin build, sin bundler, sin framework de frontend. El código, los comentarios y la UI están en inglés.

## Comandos

```bash
npm install        # postinstall descarga Chromium headless (playwright install chromium)
npm start          # servidor en http://localhost:3000; crawl al arrancar si no hay datos, luego con Refresh
npm run start:sync # igual, pero con los datos online (Neon, .env.sync): así se refresca la web
npm run crawl      # crawl puntual de todas las tiendas desde la terminal
```

No hay tests, linter ni formateador configurados. Para probar un solo crawler, impórtalo y
llámalo con su entrada de `config.js`, p. ej.:

```bash
node -e "import('./config.js').then(async ({default:c}) => { const {crawlPower} = await import('./src/crawlers/power.js'); const d = await crawlPower(c.sources.power); console.log(d.length, d[0]); })"
```

Variables de entorno: `PORT`, `CRON_SCHEDULE`, `FOOD_CRON_SCHEDULE`, `CRAWL_CONCURRENCY`, `REFRESH_COOLDOWN_MINUTES`,
`DATABASE_URL`, `OWNER_EMAIL`, `NUXT_HF_CHAT_MODEL`, `CHAT_QUESTIONS_PER_DAY`.

## Arquitectura

**`config.js` es la fuente de verdad de las tiendas.** Cada clave de `sources` es una tienda:
`type` elige el crawler (`null` = solo enlace al folleto, p. ej. H&M y Lindex, que bloquean
navegadores automatizados), `segment` la sección (`groceries` por defecto, `clothing`,
`electronics`, `beauty`, `food`). Varias tiendas pueden compartir crawler (K-Supermarket y K-Citymarket usan `kruoka`;
k-ruoka.fi a veces responde con un challenge de Cloudflare Turnstile, incluso desde casa, y entonces
la tienda falla y conserva sus deals).

**Flujo de un crawl (`src/crawl.js`):**
1. `crawlAll(log, trigger, only)` reparte las tiendas habilitadas entre un pool de workers
   (`config.concurrency`). Solo hay un crawl a la vez; las peticiones que llegan mientras tanto se
   encolan y se fusionan (`queued`) y se ejecutan al terminar.
2. Cada crawler (`src/crawlers/<type>.js`) exporta `crawlX(opts, log)` y devuelve deals con forma
   `{ id: '<type>:<sku>', name, brand, category, price, regularPrice, dealText, image, url, validUntil }`.
3. `enrich()` reescribe el `id` con la clave de la tienda, añade `source`, `segment`,
   `discountPct` y `group` (categoría unificada vía `unifyCategory` de `src/categories.js`), y pasa
   un `validUntil` de solo fecha al final de ese día en Helsinki. `crawlOne` añade `firstSeen`
   (se conserva entre crawls; `null` si ya existía o en el primer crawl), que da la etiqueta "New".
4. Si un crawler lanza error, se conservan los deals anteriores de esa tienda y se marca `ok: false`.
   Los crawlers deben lanzar (`throw`) cuando la página cambia de estructura, no devolver `[]`.
5. Solo se reescriben los ficheros de los segmentos afectados.

**Cuentas (`src/db.js`, PostgreSQL con `pg`):** tablas `users` (rol `owner`/`user`, un solo owner
por índice único parcial; el owner es el email verificado de `OWNER_EMAIL`) y `favorites`
(`user_id, segment, category`), además de `expiry_entries` y `rate_counters`. Esquema en
`src/db/schema.sql`, aplicado al arrancar (idempotente).
Necesita `DATABASE_URL` (local: `docker compose up -d`, puerto 5434); sin ella el sitio funciona sin
cuentas y el owner se deduce del token.

**Despliegue online (gratis):** Vercel (estático `public/` + `api/index.js`, que importa `app` de
`src/server.js`; con `VERCEL` no hay `listen`, ni cron real, ni crawl al arrancar) y Neon (Postgres).
**En Vercel no se crawlea** (varias tiendas bloquean sus servidores): `/api/meta` devuelve
`refresh: false`, `app.js` pone `html.no-refresh` y el CSS oculta los botones Refresh; `POST /api/crawl`
responde 404. El owner refresca desde su ordenador con `npm run start:sync` (`.env.sync` con
`DATA_STORE=postgres` y el `DATABASE_URL` de Neon, encima de `.env`): los botones Refresh de
localhost escriben en Neon y la web los ve (también el progreso, vía `crawl-progress.json`).
`npm run crawl:sync` hace lo mismo desde la terminal, `npm run push:sync -- --yes`
(`scripts/push-crawl-data.js`) sube a Neon un crawl hecho con ficheros locales (`deals-*.json`,
`status.json`, `analyst-cache.json`; sin `--yes` solo lista) y `npm run clear:sync -- --yes`
(`scripts/clear-crawl-data.js`) borra los deals, `status.json` y el progreso online, con copia en
`data/backup-crawl-*.json`. En
Vercel Chromium viene de `@sparticuz/chromium` (`src/browser.js`, usa `playwright-core`). Región
`fra1` (`vercel.json`, junto a Neon en Frankfurt). `npm run crawl` sale con código 1 si falla
alguna tienda.
`scripts/import-data.js` copia `data/*.json` a la tabla `kv` (y `expiry.json` a `expiry_entries`).

**Almacenamiento (`src/store.js`):** con `DATA_STORE=postgres` (Vercel) cada
"fichero" es una fila de la tabla `kv` (clave = nombre del fichero) vía las mismas
`readJson/writeJson/readRaw`; el progreso del crawl se guarda en `crawl-progress.json`
(`currentProgress()` en `src/crawl.js`) para que la web lo vea. Sin esa variable: JSON en `data/` (en `.gitignore`), escritura atómica
(tmp + rename). `deals-<segment>.json` por sección y `status.json` con estado por tienda,
historial de las últimas 20 ejecuciones y hora de actualización por sección. `migrateLegacy()`
convierte el antiguo `data/deals.json` único.

**Crawlers:** dos estilos. HTTP plano + cheerio/JSON embebido (Tokmanni, Lidl, KappAhl, New Yorker, KICKS, Yliopiston Apteekki;
Prisma y S-market llaman directamente a la API GraphQL de S-kaupat con `storeId` y el hash de la consulta
persistida `QUERY_HASH`, que hay que actualizar si S-kaupat la cambia) o Playwright vía `withBrowser()`
de `src/browser.js`, que normalmente intercepta las llamadas a la API interna de la propia web en vez
de parsear el DOM (K-Ruoka, Power, Verkkokauppa, Gigantti, XXL) o pulsa "cargar más" (Intersport, Stadium). Reutiliza `USER_AGENT`, `sleep` y
`declineCookies` de `src/browser.js`. Política del proyecto: no intentar saltarse protecciones anti-bot.

**Categorías (`src/categories.js`):** listas de reglas regex por segmento (`RULES`,
`CLOTHING_RULES`, `ELECTRONICS_RULES`, `FOOD_RULES`, `BEAUTY_RULES`); gana la primera que coincide, así que el orden importa
(hay grupos repetidos a propósito). En electrónica se evalúa `"<categoría> <nombre>"`; en los demás,
la categoría y, si cae en "Other", el nombre. `isClothing()` filtra ropa en XXL/Stadium (`clothingOnly`).

**Servidor (`src/server.js`):**
- `GET /api/meta` (tiendas, estado, cooldowns; se consulta con polling), `GET /api/deals?segment=`
  (sin ofertas caducadas —`isLive` de `src/validity.js`—, con gzip y ETag por contenido/304; se
  reconstruye solo si cambia `readVersion()` y se precalienta al arrancar; `Vercel-CDN-Cache-Control` 60 s,
  también en `/api/stores/top`, y 5 s en `/api/meta` para quien no es owner), `GET /api/status` (dashboard),
  `POST /api/crawl[?segment=]` (solo acepta `segment`; aplica el cooldown por tienda, 0 = desactivado por
  defecto, y devuelve 429 si no queda nada que hacer). Solo para propietarios: `requireOwner` (`src/auth.js`) verifica el ID
  token de Firebase (`Authorization: Bearer`, firma RS256 contra los certificados de Google, sin
  firebase-admin) y el rol del usuario en la tabla `users`; 401/403 si no. `requireUser` deja en
  `req.user` `{ uid, email, name, role, id }`.
  `GET /api/me` guarda/actualiza al usuario y dice si es propietario; el frontend pone `html.is-owner`
  y el CSS oculta los botones de refresco a los demás.
- `GET/PUT/DELETE /api/favorites[/:segment/:category]` y `POST /api/favorites/merge`
  (`src/favorites.js`): favoritos de la cuenta.
- `GET /api/wolt?lat=&lon=` (Food Promotions): ofertas de Wolt cerca de la ubicación del navegador,
  buscadas en vivo con Playwright (`src/wolt.js`, botón "Share location" de wolt.com), no por el cron.
  Caché por zona de ~1 km (`config.wolt`); solo las búsquedas sin caché cuentan para `rateLimits.wolt`.
  Frontend en `public/wolt.js`, montado en la sección con `data-wolt`.
- Rate limit por IP (`src/rateLimit.js`, valores en `config.rateLimits`): en memoria, salvo los
  `shared: true` (crawl, wolt, scan), que cuentan en `rate_counters` vía `hit()` de `src/db.js`.
- `GET /api/health` (sin rate limit): `{ ok, db, lastCrawl }`, 503 si la base de datos no responde.
- Login con Google mediante Firebase Authentication, todo en el navegador (`public/auth.js`, SDK
  cargado desde gstatic con versión fija). El servidor solo expone la configuración web pública de
  Firebase en `GET /api/auth-config` (`src/auth.js`, variables `FIREBASE_*` de `.env`); sin ellas el
  botón de Google del diálogo aparece desactivado. Las rutas que exigen sesión reciben el ID token
  de Firebase en `Authorization: Bearer` y lo verifica `src/auth.js` (sin `firebase-admin`):
  `requireOwner` (refrescos) y `requireUser` (deja `req.user = { uid, email }`).
- **Follow your discount** (`/follow`, `src/expiry.js` + `public/expiry.js`): el usuario fotografía
  etiquetas, "Check" envía cada foto (reducida en el navegador a ≤ 768 px) a
  `POST /api/expiry/scan`, que llama a un modelo de visión de Hugging Face (`NUXT_HF_VISION_MODEL`,
  por defecto `Qwen/Qwen3-VL-30B-A3B-Instruct:fastest`) con `max_tokens: 100` y corte a los 8 s
  (~500 tokens y 1–2 s por foto). El modelo devuelve la fecha y **las palabras impresas junto a
  ella**; el tipo (use-by / best-before / fecha de envasado, que se descarta) lo decide `KINDS` en
  código, porque el modelo los confunde. Las fechas encontradas no se guardan solas: un diálogo de revisión
  (nombre, fecha, tipo, ubicación; Save / Cancel) las guarda con `POST /api/expiry`. "Enter manually" abre ese mismo diálogo con una fila vacía, sin foto. Las fechas se muestran siempre como dd/mm/yyyy (`public/datefield.js`: texto con máscara + `<input type="date">` transparente sobre el icono para el selector del dispositivo; el valor ISO va en `data-iso`). Las fechas se guardan por usuario en la tabla `expiry_entries`
  (sin `DATABASE_URL`, en `data/expiry.json`; CRUD en `/api/expiry`); las fotos no se guardan.
  Límites: `rateLimits.scan` por IP y `expiryScansPerDay` por usuario, contados en la tabla
  `rate_counters` para que valgan entre instancias de Vercel. Cada foto con fecha encontrada gasta
  1 "check" (`src/credits.js`: `reserve()` antes del modelo, `settle()` lo devuelve si no hay
  fecha; 3 al empezar +1 por semana; el owner no paga). Sin checks → 402. Se compran en `/pricing`
  (`public/pricing.js`) con Stripe Checkout (`src/billing.js`, planes en `config.credits.plans`);
  el webhook `POST /api/billing/webhook` (cuerpo raw, antes del rate limit) verifica la firma y el
  importe y concede una vez por sesión (tabla `purchases`).
- **Deals assistant** (chat flotante abajo a la derecha, `public/chat.js`; `POST /api/chat`, con sesión):
  1) `src/chatGuard.js` valida la pregunta antes de nada (tamaño ≤ `config.chat.maxChars`, código,
  HTML, SQL, shell, prompt injection, temas ajenos → 400 gratis, sin modelo); 2) `src/chat.js` `plan`:
  el modelo de texto (`NUXT_HF_CHAT_MODEL` o `NUXT_HF_MODEL`) devuelve solo lo que dice el mensaje
  (*delta*: intent, product, topics, stores, keywords EN+FI, `turn` new/refine; `validateDelta` con
  listas blancas) y `mergeIntent()` (código puro) lo combina con la **memoria**, la búsqueda anterior
  guardada en el servidor (`history.context`; el navegador no la envía): "kana" → "in Tokmanni" = kana
  en Tokmanni; 3) caché; 4) `reserve()` 1 check; 5) `src/dealIndex.js` busca en **un solo índice** con
  todas las secciones + la caché de Wolt de Oulu: los `TOPICS` cruzan secciones (ropa = sección clothing
  + "Clothing & shoes" de Tokmanni/Prisma), con keywords (producto concreto) cada item debe contener una
  (al inicio de palabra; ≥ 5 letras también al final de un compuesto), sin keywords (categoría) decide el
  topic; los resultados se reparten entre tiendas; 6) `summarise` escribe la respuesta solo con esos
  items (plantilla si falla; sin resultados: "Unfortunately, there is no … in … at the moment."). Las
  tarjetas salen de nuestros datos, nunca del modelo. Se cobra solo si encuentra deals
  (`settle(…, 'chat')`); límites `rateLimits.chat` y `config.chat.perDay`.
  La conversación se guarda por usuario (`src/chatHistory.js`: `chat-<hash uid>.json`, fila de `kv` online) y se
  borra 24 h después de empezar (`expiresAt`, no se alarga); `/clear` o "clear the chat" (`isClearCommand`)
  la borra antes (también `DELETE /api/chat/history`); `/new` o "new search" borra solo la memoria
  (`resetContext`). Caché de respuestas compartida (`chatcache-<hash>.json`, clave = búsqueda ya combinada
  + `dataVersion()`, 24 h): repetir una búsqueda no gasta check. Las preguntas no van a los logs.
- Sin refresco automático por defecto: el owner refresca a mano (~1 vez por semana). Solo en servidor local, `CRON_SCHEDULE` (`config.schedule`) y
  `FOOD_CRON_SCHEDULE` (`config.sectionSchedules`) activan cron (ignora el cooldown); el dashboard
  muestra el próximo (`nextSchedule()` en `src/server.js`) o "Manual".

**Frontend (`public/`):** HTML/JS vanilla. `/dashboard`, `/promotions` (también `/`), `/clothing`,
`/electronics`, `/beauty`, `/food` y `/follow` sirven el mismo `index.html`; `app.js` muestra la `<section data-view>` según la ruta.
Cada `<section data-segment>` carga sus deals solo al abrirse. Los favoritos (categorías con ★)
se guardan en localStorage por sección sin sesión, y en la cuenta con sesión (`account.active` en
`app.js`; se fusionan una vez por inicio de sesión vía `ipromotion:account` de `auth.js`); `/favorites` (`FavoritesView` en `app.js`) junta los deals de
las categorías favoritas de todas las secciones, leyendo los `PromoView`. En escritorio la barra lateral se
pliega a una columna de iconos (`.app.sidebar-collapsed`, guardado en localStorage y restaurado por un
`<script>` en línea antes de pintar); en móvil sigue siendo el cajón deslizante. `dashboard.js` pinta `/api/status`. Encima de las tarjetas, `store3d.js` dibuja con three.js (CDN jsdelivr fijado en el
import map de `index.html`, cargado solo al abrir el dashboard) un pueblo: cuadrícula de calles
(`STREET_X`/`STREET_Z`, grafo de cruces), una manzana por sección (groceries, clothing, electronics y food; Beauty & Health aún no tiene manzana) con sus tiendas (escaparates con sus
mejores ofertas reales de `GET /api/stores/top`, lámpara verde/ámbar según el último crawl), la HQ y un
parking con 4 coches. Hay un robot procedural por sección: en un Refresh (`updateStore3d(status)` en cada
sondeo) conduce por la ruta más corta (Dijkstra, carril derecho, gira en los cruces) a la tienda que se
está crawleando, aparca, va a pie a la puerta y escanea; al terminar vuelve al parking y celebra o se
desanima. "Find all discounts" repite el recorrido sin crawlear; pulsar una tienda manda a su robot.
Las acciones de cada robot son una cola (`board`/`drive`/`alight`/`walk`/`pose`/`hold`/`call`). Sin
WebGL o sin CDN se oculta.
Logo en `public/logo.svg`; el favicon (`favicon.svg`) es el mismo dibujo con la etiqueta más grande, y
`favicon-32.png` / `apple-touch-icon.png` son copias PNG renderizadas de él (regenerarlas si cambia).

## Tareas habituales

- **Añadir tienda:** entrada en `config.js` (+ logo en `public/logos/` si aplica); si es un tipo
  nuevo, crear `src/crawlers/<type>.js` y registrarlo en `CRAWLERS` de `src/crawl.js`. Revisar que
  sus categorías encajen en las reglas de `src/categories.js`. Actualizar la tabla del README.
- **Añadir sección:** `segment` en las tiendas, reglas + fallback en `SEGMENT_RULES`, enlace de nav
  y `<section data-view data-segment>` en `public/index.html`, y la ruta en la lista de
  `app.get([...])` de `src/server.js`.

`docs/ROADMAP.md` recoge el trabajo pendiente (SQLite + API paginada, historial de precios, alertas,
tests con fixtures por crawler).
