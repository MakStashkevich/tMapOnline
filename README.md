<div align="center">
  <h1 align="center"><img src="docs/images/map-markers/rabbit.png" height="32" alt="rabbit" align="absmiddle"> tMapOnline</h1>
  <p><strong>A real-time online Terraria map – one shared world, and everything happening in it right now.</strong></p>
  <p>World exploration · players and NPCs · bosses · routes · Map Ping between browser and game</p>
  <p><a href="README.md">🇺🇸 English</a> · <a href="README_RU.md">🇷🇺 Русский</a> · <a href="README_UK.md">🇺🇦 Українська</a> · <a href="README_FR.md">🇫🇷 Français</a> · <a href="README_JA.md">🇯🇵 日本語</a> · <a href="README_ZH_CN.md">🇨🇳 简体中文</a> · <a href="README_KO.md">🇰🇷 한국어</a></p>
</div>

we were playing Terraria with friends. one of them loved finding new places, exploring biomes, and building houses. one day he asked: “could we see what everyone has explored on one map?” i couldn't find a ready-made map that showed the team's shared progress and what was happening in the world live, so i decided to try making one. that's how tMapOnline started.

it began as a simple server status page – how long the server had been running and how much memory it used. then i added players, NPCs, bosses, and their sprites. the map came later. now i can open it in a browser, see what's going on, and help a friend from my phone: i place a Map Ping and it appears in their game. i don't need to launch Terraria myself.

## what's on the map

![tMapOnline world map](docs/images/world-map-overview.png)

- shared world exploration and player routes for the period set in the server config;
- players, NPC and boss heads, pylons, coins, spawn point, death markers, and Map Ping;
- live tile changes and unexplored areas shaded with soft edges and lighting;
- Terraria background textures, a pixel-style menu, and tooltips, including on phones;
- player and session history, boss progress, server status, resource usage, and grouped events.

the map uses in-game sprites for players <img src="docs/images/map-markers/player.png" height="22" alt="player sprite" align="absmiddle">, NPC heads <img src="docs/images/map-markers/npc-example.png" height="22" alt="NPC sprite" align="absmiddle">, and bosses – for example, the Wall of Flesh <img src="docs/images/map-markers/boss-wall-of-flesh.png" height="22" alt="Wall of Flesh sprite" align="absmiddle">. pylons <img src="docs/images/map-markers/pylon.png" height="22" alt="pylon sprite" align="absmiddle">, gold coins <img src="docs/images/map-markers/gold-coin.png" height="22" alt="gold coin" align="absmiddle">, the spawn point <img src="docs/images/map-markers/spawn.png" height="22" alt="spawn point" align="absmiddle">, death markers <img src="docs/images/map-markers/death.png" height="22" alt="death marker" align="absmiddle">, and Map Ping <img src="docs/images/map-markers/map-ping.gif" height="22" alt="Map Ping sprite" align="absmiddle"> use them too.

display settings belong to each browser. you can choose which players and layers to show, enable routes, or change animation; these preferences stay in that browser's `localStorage` and do not affect what other players see. the server owner sets the service address, update frequency, data retention, and available features in the YAML config.

## run it

you need Python 3.9 or newer. install tModLoader if you want tMapOnline to start a local game server too. node.js is only needed to build the web interface.

first build the web files. the generated `tmaponline/web/assets` directory is not stored in Git; the build creates it:

```sh
npm ci
npm run build
```

then install tMapOnline and copy the example config:

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -e .
cp config.example.yaml config.local.yaml
```

to start the web map together with a local Terraria server:

```sh
tmaponline --config config.local.yaml run
```

if the game server is managed separately, start only the web service:

```sh
tmaponline --config config.local.yaml serve
```

open the address from `server.host` and `server.port`. by default, it is `http://127.0.0.1:8765`. the `run` command starts the game server specified in the config. if another process is already using its port, tMapOnline leaves it alone.

### server mod

the mod is needed only on the server's tModLoader installation; players do not need to install it. it sends world data to the web service and forwards Map Ping from the browser to connected players.

build the mod with the tModLoader version used by your server:

```sh
TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py
```

the build script places `dist/tMapOnline.tmod` in the project. it does not replace the mod installed on a running server. copy the package to the server profile's Mods folder and enable `tMapOnline`. restart the server only when nobody is playing.

### checks and rebuilds

after changing the web source, rebuild the interface:

```sh
npm ci
npm run build
```

available checks: `npm run typecheck`, `npm run check:python`, `npm run check:web`, and `npm run check:all`. `npm run check:web` also rebuilds the interface.

## config and data

the example server config is in [config.example.yaml](config.example.yaml). detailed technical docs are available in English: [server settings](docs/en/configuration.md), [architecture](docs/en/architecture.md), [web map](docs/en/web-map.md), [server mod](docs/en/mod.md), [telemetry and HTTP API](docs/en/telemetry.md), and [updating](docs/en/migration.md).

by default, tMapOnline stores data in `~/Library/Application Support/tMapOnline`. this folder contains map cache, player history, imported maps, and boss progress. you can change the path with `storage.data_dir` in the server YAML config.

## license and attribution

the source code is available under the MIT License. you can use it, change it, include it in commercial projects, and redistribute it. if you make a fork or build a project based on tMapOnline, keep the [LICENSE](LICENSE) file and a link to the source: [tMapOnline on GitHub](https://github.com/MakStashkevich/tMapOnline).

some assets have their own terms. for example, [LICENSE-lzx.txt](tmaponline/sprite_renderer/LICENSE-lzx.txt) applies to the LZX component, not the whole project. check the licenses for images, fonts, and third-party tools before redistributing them.
