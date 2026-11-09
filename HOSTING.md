# Хостинг и безопасность

Дата последней проверки зависимостей: 2026-11-09 (`npm audit` — 0 уязвимостей,
OSV API по точным версиям — пусто; свежие CVE Vite затрагивают только dev-сервер,
см. раздел «Зависимости»).

## Модель угроз (читать перед любым изменением)

Приложение — чистая статика. Файл чата идёт так:

```
FileReader (память вкладки) → postMessage → dedicated Worker (same-origin) → Sigma canvas
```

Сервер отдаёт только `dist/` и **никогда не видит содержимое чатов**:
в коде нет `fetch` / `XHR` / `WebSocket` / `sendBeacon`, внешних URL нет,
шрифты self-hosted. Поэтому:

1. Данные посетителей нельзя украсть через сервер — их там нет.
2. Главная угроза origin'у — будущий XSS из слов чата (сегодня все приёмники
   чистые: `textContent`, `escapeHtml`, canvas `fillText`; детали — в отчёте аудита).
3. Любая фича вида «поделиться / сохранить на сервере / телеметрия»
   ломает эту модель. Такой фиче — отдельный аудит безопасности.

## Обязательные заголовки (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name chatmap.example.com;
    root /var/www/chatmap/dist;

    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob: data:; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    # Только после проверки, что весь сайт стабильно на HTTPS:
    # add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }
    location = /index.html {
        add_header Cache-Control "no-cache" always;
    }
}
```

### Caddy (альтернатива)

```
chatmap.example.com {
    root * /var/www/chatmap/dist
    file_server
    header {
        Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob: data:; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }
}
```

CSP строгий и ничего не ломает: внешних скриптов/стилей/шрифтов в приложении
нет (проверено grep по `http`/`url(` в `src/styles/` и `index.html` — пусто).
`frame-ancestors 'none'` заодно убивает clickjacking.

## Зависимости

| Пакет | Стоит | Новейший (на 2026-11-09) | OSV по точной версии |
|---|---|---|---|
| vite | 8.3.5 | 8.3.7 | пусто |
| sigma | 4.0.4 | 4.0.5 | пусто |
| graphology | 0.26.0 | 0.26.0 | пусто |
| graphology-layout-forceatlas2 | 0.10.1 | — | пусто |
| @sigma/export-image | 4.0.0 | — | пусто |
| vitest (dev) | 5.0.5 | 5.1.0 | пусто |

Известные уязвимости Vite (GHSA-g4jq, GHSA-jqfw, GHSA-p9ff, GHSA-v2wj, GHSA-r825,
GHSA-rq7h, GHSA-vfpm, GHSA-x574, GHSA-xcj6 и др.) — **все только про dev-сервер**
(`server.fs.deny`/`allow`, middleware, launch-editor, WebSocket). На раздачу
`vite build` они не влияют: прод-бандл — мёртвые файлы. Для локальной разработки
dev-сервер и так слушает только `127.0.0.1` (`vite.config.ts`). Обновить vite до
8.3.7 можно плановым патчем, 보안-давления нет.

## Чеклист перед каждым деплоем

- [ ] `npm audit` — 0 уязвимостей.
- [ ] `npm run build`; проверить, что в `dist/assets/*.js` нет строки `fixture`
      (dev-ветка `?fixture=1` обязана выпадать из прод-бандла).
- [ ] В `dist/` нет `.map`-файлов (не светить исходники/пути).
- [ ] Заголовки из раздела выше отдаются (проверить `curl -I`).
- [ ] `tests/fixtures/` — только синтетика; реальный `result.json` и скриншоты
      `tests/betterwright/` не покидают машину (оба пути в `.gitignore`).
- [ ] В `tools/*.mjs` нет захардкоженных путей к реальным данным
      (см. историю с `REAL_JSON` — только через env).
