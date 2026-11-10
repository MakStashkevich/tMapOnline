# Terraria World Viewer

Самостоятельный локальный просмотрщик мира Terraria: веб-интерфейс, Python API, поток телеметрии и исходники серверного tModLoader-мода. Интерфейс написан на TypeScript и SCSS, использует vanilla ES modules без frontend runtime и собирается в минифицированные статические файлы. Для интерфейса используется библиотека Lucide: только нужные SVG-иконки включаются в локальную сборку, поэтому браузеру не нужны CDN или отдельный runtime. Данные Viewer хранятся в `~/Library/Application Support/TerrariaWorldViewer`.

## Быстрый запуск

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
cp config.yaml config.local.yaml
terraria-viewer --config config.local.yaml serve
```

Откройте `http://127.0.0.1:8765`. Команда `serve` поднимает API и принимает локальную телеметрию, не запуская игру. Команда `run` поднимает Viewer и tModLoader на локальной машине; если сервис уже запущен отдельно, используйте `serve`. Перед `run` проверьте, что игровой порт свободен: автоматическая остановка другого сервера не выполняется.

Порт телеметрии по умолчанию — `127.0.0.1:38762`. Соберите мод командой `python3 tools/build-mod.py` (при нестандартном пути задайте `TML_ROOT`); скрипт использует изолированный профиль и кладёт результат в `dist/TerrariaWorldViewerTelemetry.tmod`, не перезаписывая установленный мод запущенного сервера. Установите его в серверный экземпляр tModLoader и включите мод.

## Настройка

`config.yaml` содержит адреса, порт, мир, каталог сохранений и feature flags страниц/модулей. Пользовательские переключатели слоёв карты и другие настройки интерфейса остаются в браузерном хранилище пользователя и не перезаписываются конфигурацией сайта. Каталог с историей и картой сохранён в прежнем месте по умолчанию.

Структура страниц и feature flags: [docs/configuration.md](docs/configuration.md). Архитектурные границы: [docs/architecture.md](docs/architecture.md). Перенос и запуск: [docs/migration.md](docs/migration.md). Протокол: [docs/telemetry.md](docs/telemetry.md).

## Сборка веб-интерфейса

Для разработки установите Node.js и соберите интерфейс:

```sh
npm ci
npm run format
npm run check:web
```

Исходники TypeScript и SCSS находятся в `terraria_viewer/web/src`; готовые файлы появляются в `terraria_viewer/web/assets`. Python-сервис раздаёт собранный интерфейс без Node.js и npm в рабочем окружении.
