# Архитектура Terraria World Viewer

## Проекты и границы

```text
terraria-world-viewer/
├── terraria_viewer/
│   ├── backend/       # HTTP API/static hosting и фасад существующей модели данных
│   ├── telemetry/     # reconnectable JSONL client
│   ├── web/
│   │   ├── src/       # TypeScript, SCSS и разделённые frontend modules
│   │   ├── assets/    # собранные минифицированные JS/CSS, раздаваемые сервером
│   │   └── world-map/ # HTML entry point
│   ├── sprite_renderer/
│   ├── config.py      # YAML schema/defaults/feature flags
│   └── runtime.py     # локальный lifecycle сервиса и игрового процесса
├── tmodloader/        # отдельный серверный мод, поставщик телеметрии
└── docs/
```

`backend/http.py` отвечает за API и границу HTTP. `backend/store.py` — стабильный фасад модели. Его доменные части находятся в `backend/services/`: `player_history`, `movement`, `live_telemetry`, `monitoring`, `world_map`. Общие файловые форматы и константы вынесены в `store_common.py`; mixin-срезы разделяют ответственность, но сохраняют один объект и единые locks/кэши. Это позволяет делить реализацию, не меняя API и существующий формат файлов.

`telemetry/stream.py` принимает newline-delimited JSON snapshots. Мод собирает состояние сервера и отправляет его на localhost. Web не обращается к игровому процессу напрямую: он читает согласованный API.

## Разбиение интерфейса

`web/world-map/index.html` — единственная точка входа Viewer. `/` и `/world-map` открывают одну карту; старый экран мониторинга выключен. Исходники оболочки, карты, разделов и стилей находятся в `web/src`. `npm run build` компилирует и минифицирует TypeScript в ES-модули и SCSS в CSS внутри `web/assets`. В production Python раздаёт готовые файлы и не требует Node.js.

`src/app-shell.ts` управляет меню разделов, темой и переключением вида. Карта запускается сразу; модули `src/sections/{world,players,bosses,server,activity}.ts` импортируются динамически, когда открывается соответствующая вкладка. Стили каждой вкладки также загружаются отдельно. Исходники стилей сгруппированы в `src/styles`: общие токены, базовые правила, компоненты, layout, карта и разделы. Тема сохраняется в localStorage и задаётся `data-theme` на корневом элементе; карта мира сохраняет свою игровую палитру, оболочка и разделы меняют светлую/тёмную тему.

Боковое меню содержит карту, игроков и историю игровых сессий, боссов и прогресс мира, состояние сервера, нагрузку и события. Слои исследования и маршруты игроков показываются только в разделе карты. Разделы можно включать в `site.sections` конфигурации. Backend обслуживает их через отдельный компактный `/api/section-data?section=...`; полноразмерный `/api/status` остаётся для совместимости и не используется как источник для интерфейса разделов. При смене раздела карта приостанавливает частое обновление, а при возврате обновляет карту и продолжает опрос.

UI использует нативные ES modules без frontend runtime и компонентной библиотеки. Граница загрузки явная: оболочка отвечает за навигацию, SCSS раздела — за его визуальные правила, `mount(root)` — за запрос и рендер данных. Сборка через esbuild и Sass выполняется при разработке/пакетировании; runtime-зависимости страницы отсутствуют. Это сохраняет лёгкий запуск карты и не загружает аналитику, историю игроков и журналы, пока пользователь их не запросит.

Frontend-команды: `npm ci` устанавливает закреплённый lock-файлом toolchain, `npm run typecheck` проверяет TypeScript, `npm run build` обновляет `web/assets`, `npm run check:web` выполняет обе операции подряд. После изменений исходников необходимо собрать assets до запуска или упаковки Viewer.

## Состояние и конфигурация

`config.yaml` — конфигурация запуска, включения страниц и разделов. Клиентская тема, выбранные игроки/слои и положение карты хранятся отдельно в localStorage. Персональные данные и кэши остаются в прежнем каталоге TerrariaTunnel, не в репозитории. Схему API и телеметрии см. в [telemetry.md](telemetry.md).

Структура конфигов вдохновлена component/config layouts [Dynmap](https://dynmap.wiki.gg/wiki/Component_Configuration), [BlueMap](https://github.com/BlueMap-Minecraft/BlueMapWiki/blob/master/wiki/configs/Webapp.md) и [squaremap](https://github.com/jpenilla/squaremap/wiki/Default-config.yml); формат адаптирован к небольшому односерверному приложению.
