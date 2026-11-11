<div align="center">
  <h1 align="center"><img src="docs/images/map-markers/rabbit.png" height="32" alt="кролик" align="absmiddle"> tMapOnline</h1>
  <p><strong>онлайн-мапа Terraria в реальному часі – спільний світ і все, що відбувається в ньому просто зараз.</strong></p>
  <p>дослідження світу · гравці та NPC · боси · маршрути · Map Ping між браузером та грою</p>
  <p><a href="README.md">🇺🇸 English</a> · <a href="README_RU.md">🇷🇺 Русский</a> · <a href="README_UK.md">🇺🇦 Українська</a> · <a href="README_FR.md">🇫🇷 Français</a> · <a href="README_JA.md">🇯🇵 日本語</a> · <a href="README_ZH_CN.md">🇨🇳 简体中文</a> · <a href="README_KO.md">🇰🇷 한국어</a></p>
</div>

ми грали з друзями в Terraria. один із них дуже любив знаходити нові місця, досліджувати біоми й будувати будинки. якось він запитав: «а можна побачити на одній мапі, що відкрили всі гравці?» я не знайшов готової мапи зі спільним прогресом команди та подіями у світі в реальному часі, тож вирішив спробувати зробити її сам. так з’явився tMapOnline.

спочатку це була проста сторінка зі станом сервера – як довго він працює та скільки пам’яті використовує. потім з’явилися гравці, NPC, боси та їхні спрайти, а вже після цього – мапа. тепер я можу відкрити її в браузері й допомогти другові з телефона: поставити Map Ping, який з’явиться в його грі. мені не потрібно самому запускати Terraria.

## що є на мапі

- спільне дослідження світу та маршрути гравців за період із конфігурації сервера;
- гравці, голови NPC і босів, пілони, монети, точка появи, позначки смерті та Map Ping;
- зміни блоків у реальному часі й плавне затемнення недосліджених місць з урахуванням освітлення;
- фонові текстури Terraria, піксельне меню та підказки, зокрема на телефоні;
- історія гравців і сесій, прогрес босів, стан сервера, навантаження та згруповані події.

для гравців <img src="docs/images/map-markers/player.png" height="22" alt="спрайт гравця" align="absmiddle">, голів NPC <img src="docs/images/map-markers/npc-example.png" height="22" alt="спрайт NPC" align="absmiddle"> і босів – наприклад, Стіни плоті <img src="docs/images/map-markers/boss-wall-of-flesh.png" height="22" alt="спрайт Стіни плоті" align="absmiddle"> – використовуються ігрові спрайти. Так само виглядають пілони <img src="docs/images/map-markers/pylon.png" height="22" alt="спрайт пілона" align="absmiddle">, золоті монети <img src="docs/images/map-markers/gold-coin.png" height="22" alt="золота монета" align="absmiddle">, точка появи <img src="docs/images/map-markers/spawn.png" height="22" alt="точка появи" align="absmiddle">, місця смерті <img src="docs/images/map-markers/death.png" height="22" alt="місце смерті" align="absmiddle"> та Map Ping <img src="docs/images/map-markers/map-ping.gif" height="22" alt="спрайт Map Ping" align="absmiddle">.

налаштування вигляду належать кожному браузеру окремо. Можна вибрати гравців і шари, увімкнути маршрути чи змінити анімацію. Ці параметри зберігаються в `localStorage` браузера й не впливають на інших. Адресу сервісу, частоту оновлень, строк зберігання даних і доступні функції власник сервера задає у YAML-конфігурації.

## запуск

потрібен Python 3.9 або новіший. Встанови tModLoader, якщо хочеш запускати через tMapOnline ще й локальний ігровий сервер. Node.js потрібен лише для збирання вебінтерфейсу.

спочатку збери вебфайли. Каталог `tmaponline/web/assets` створюється під час збирання і не зберігається в Git:

```sh
npm ci
npm run build
```

потім встанови tMapOnline і скопіюй приклад конфігурації:

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -e .
cp config.example.yaml config.local.yaml
```

щоб запустити мапу разом із локальним сервером Terraria:

```sh
tmaponline --config config.local.yaml run
```

якщо сервером гри керує інша програма, запусти лише вебсервіс:

```sh
tmaponline --config config.local.yaml serve
```

відкрий адресу з `server.host` і `server.port`. За замовчуванням це `http://127.0.0.1:8765`. Команда `run` запускає сервер, указаний у конфігурації. Якщо його порт уже зайнятий іншим процесом, tMapOnline не зупинятиме той процес.

### серверний мод

мод потрібен лише на серверному профілі tModLoader – гравцям його встановлювати не треба. Він передає дані світу вебсервісу та надсилає гравцям Map Ping із браузера.

збери мод під ту версію tModLoader, яку використовує сервер:

```sh
TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py
```

скрипт збере `dist/tMapOnline.tmod`, але не замінить мод на запущеному сервері. Скопіюй пакет до папки Mods серверного профілю та увімкни `tMapOnline`. Перезапускай сервер, лише коли гравців у грі немає.

## налаштування та дані

приклад конфігурації є у [config.example.yaml](config.example.yaml). Технічна документація наразі лише російською: [налаштування сервера](docs/configuration.md), [архітектура](docs/architecture.md), [вебмапа](docs/web-map.md), [серверний мод](docs/mod.md), [телеметрія та HTTP API](docs/telemetry.md), [оновлення](docs/migration.md).

за замовчуванням дані зберігаються в `~/Library/Application Support/tMapOnline`: там є кеш мапи, історія гравців, імпортовані мапи та прогрес босів. Шлях можна змінити через `storage.data_dir` у конфігурації сервера.

## ліцензія та авторство

вихідний код доступний за ліцензією MIT. Його можна використовувати, змінювати, додавати до комерційних проєктів і поширювати далі. Якщо створюєш форк або проєкт на основі tMapOnline, залиш файл [LICENSE](LICENSE) і посилання на [вихідний код на GitHub](https://github.com/MakStashkevich/tMapOnline).

окремі ресурси можуть мати власні умови. Наприклад, [LICENSE-lzx.txt](tmaponline/sprite_renderer/LICENSE-lzx.txt) стосується компонента LZX, а не всього проєкту. Перед поширенням перевір ліцензії зображень, шрифтів і сторонніх інструментів.
