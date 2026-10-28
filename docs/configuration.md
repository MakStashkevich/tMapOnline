# Конфигурация и блоки сайта

Конфиг YAML версии `1` валидируется в `terraria_viewer/config.py`; отсутствующие поля получают defaults. Перезапуск нужен после изменения файла.

```yaml
site:
  pages:
    world_map: { enabled: true }
  sections:
    world: true
    players: true
    bosses: true
    server: true
    activity: true
  modules:
    world_map.exploration: true
    world_map.entities: true
```

Полный набор ключей см. в корневом `config.yaml`.

| Ключ                           | Назначение                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `site.pages.world_map.enabled` | Включает Viewer и маршрут страницы карты.                                                                                      |
| `site.sections.*`              | Включает вкладки данных: мир, игроки, боссы, сервер и нагрузка. Данные вкладки запрашиваются при её открытии.                  |
| `site.modules.world_map.*`     | Включает отдельные слои карты: исследование, маршруты, игроки, сущности, монеты, пилоны, точку появления, подсказки и отладку. |

Если страница выключена, сервер возвращает 404. Выключенный раздел скрывается в меню и его данные не запрашиваются при открытии; выключенный слой карты не запускает соответствующий рендер. Для нового слоя добавьте default, запись в `terraria_viewer/web/src/core/modules.ts` и описание здесь. Клиентские настройки отображения хранятся отдельно от серверной конфигурации.

## Сборка интерфейса

Редактируемые исходники находятся в `terraria_viewer/web/src`: TypeScript — в файлах интерфейса и разделов, SCSS — в `styles`. Установите инструменты разработки и соберите статические файлы:

```sh
npm ci
npm run format
npm run check:web
```

Сборка выпускает минифицированные ES-модули и CSS в `terraria_viewer/web/assets`; Python раздаёт их без Node.js в рабочем окружении. Разделы карты, игроков, боссов, сервера и событий остаются отдельными динамическими чанками со своими CSS-файлами.

Состав страниц и отдельных UI-компонентов сделан конфигурируемым по мотивам [Dynmap](https://dynmap.wiki.gg/wiki/Component_Configuration), [BlueMap Webapp](https://github.com/BlueMap-Minecraft/BlueMapWiki/blob/master/wiki/configs/Webapp.md) и [squaremap](https://github.com/jpenilla/squaremap/wiki/Default-config.yml).
