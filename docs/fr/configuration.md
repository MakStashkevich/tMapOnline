# configuration et sections web

Ce document explique les paramètres du serveur. YAML est un format texte à indentation : les espaces indiquent à quel groupe appartient un paramètre. La configuration serveur détermine quelles données collecter et quelles fonctions activer. Elle est commune à tous les visiteurs. Chaque navigateur conserve séparément son zoom et la visibilité des couches dans `localStorage`.

`tmaponline/config.py` lit et valide le fichier avant le démarrage. Un paramètre absent prend sa valeur par défaut. Après toute modification, redémarrez le service pour qu’il charge les nouvelles valeurs.

```yaml
site:
  world_map:
    route_history_days: 7 # Durée de l’historique en jours (1–365)
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

L’exemple montre le groupe `site`, qui règle la carte et les sections. Le fichier contient aussi `storage` et `telemetry`. Après les deux-points se trouve la valeur : `true` active, `false` désactive. `7` signifie que la carte demande les sept derniers jours d’itinéraires. Respectez les espaces d’indentation : ils déterminent le groupe du paramètre.

Lorsque « Historique des itinéraires » est activé sur une fiche joueur, la carte demande automatiquement les points de la période `site.world_map.route_history_days`. Indiquez une valeur de 1 à 365.

Les paramètres suivants définissent la conservation de l’historique et les intervalles de mise à jour. La télémétrie correspond aux informations que le mod envoie automatiquement au service pendant le jeu.

```yaml
storage:
  death_retention_seconds: 3600 # 0 — conserver les morts sans limite
  event_retention_seconds: 2592000 # 30 jours ; 0 — aucune limite de durée
  event_max_entries: 5000 # Nombre maximal d’événements
telemetry:
  player_position_interval_ticks: 6 # Positions, 6 ticks ≈ 100 ms
  entity_interval_ticks: 6 # PNJ, boss, pièces et pylônes
  map_capture_interval_ticks: 30 # Couleurs de la carte autour des joueurs
  map_tile_update_interval_ticks: 1 # Tuiles et murs modifiés, explosions comprises
  map_pings_from_players_to_web: true # Afficher les pings des joueurs sur la carte
  map_pings_from_web_to_players: true # Envoyer les pings web aux joueurs
  initial_world_scan_enabled: true # Scanner tout le monde au démarrage
  world_scan_interval_ticks: 1 # Pause entre les tuiles du scanner
  browser_live_poll_interval_ms: 50 # Interrogation légère des données en direct
  browser_overview_poll_interval_ms: 250 # Mise à jour en vue d’ensemble
  browser_map_poll_interval_ms: 5000 # Intervalle des mises à jour de carte
  browser_debug_poll_interval_ms: 1000 # Intervalle avec les réglages debug ouverts
```

La durée de conservation s’applique aussi aux morts déjà enregistrées. Pour chaque mort, le mod envoie un ID stable et attend l’accusé de réception du service Python. En cas de coupure, l’événement reste en file et sera renvoyé.

Le journal est nettoyé au démarrage et après chaque nouvelle entrée : les entrées plus anciennes que `storage.event_retention_seconds` sont supprimées, puis seules les `storage.event_max_entries` plus récentes sont conservées. `0` désactive la limite temporelle, mais pas la limite de quantité.

Certains intervalles sont exprimés en ticks du jeu. Un tick est une étape ; à 60 ticks par seconde, six ticks durent environ 100 ms. tMapOnline transmet ces valeurs au mod. Les intervalles du navigateur sont en millisecondes : 1000 ms font une seconde. La grande carte est chargée séparément ; positions, objets et petites modifications arrivent par `/api/world-map/live`, sans recharger toute la carte.

Tous les paramètres et leurs valeurs par défaut figurent dans `config.example.yaml`. Le fichier actif est passé avec `--config`, par exemple `tmaponline --config config.local.yaml serve`.

| Clé                                           | Rôle                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `site.pages.world_map.enabled`                | Active la carte web tMapOnline.                                                                                                |
| `site.sections.*`                             | Active monde, joueurs, boss, serveur et activité. Les données sont demandées à l’ouverture de la section.                      |
| `site.modules.world_map.*`                    | Active les couches d’exploration, itinéraires, joueurs, entités, pièces, pylônes, apparition, infobulles et diagnostic.        |
| `storage.death_retention_seconds`             | Durée de conservation des marqueurs de mort. `0` désactive le nettoyage automatique. Par défaut : 3600.                        |
| `storage.event_retention_seconds`             | Durée de conservation des événements en secondes. `0` désactive la limite temporelle. Par défaut : 2592000 (30 jours).         |
| `storage.event_max_entries`                   | Nombre maximal d’entrées récentes. Par défaut : 5000.                                                                          |
| `telemetry.player_position_interval_ticks`    | Intervalle des positions en ticks. Le serveur local utilise `1`.                                                               |
| `telemetry.entity_interval_ticks`             | Intervalle des PNJ, boss, pièces et pylônes. Le serveur local utilise `1`.                                                     |
| `telemetry.map_capture_interval_ticks`        | Fréquence de capture des couleurs autour des joueurs.                                                                          |
| `telemetry.initial_world_scan_enabled`        | Active le scan initial complet. Désactivez-le pour tester les changements dus aux déplacements et aux modifications de tuiles. |
| `telemetry.world_scan_interval_ticks`         | Intervalle de traitement des tuiles par le scanner.                                                                            |
| `telemetry.map_tile_update_interval_ticks`    | Fréquence des tuiles et murs modifiés ; les hooks suivent minage, pose et explosions.                                          |
| `telemetry.map_pings_from_players_to_web`     | Transmet les pings du jeu vers la carte web.                                                                                   |
| `telemetry.map_pings_from_web_to_players`     | Transmet les pings web aux joueurs du serveur.                                                                                 |
| `telemetry.browser_live_poll_interval_ms`     | Intervalle des requêtes légères, 50 ms par défaut pour des marqueurs fluides.                                                  |
| `telemetry.browser_overview_poll_interval_ms` | Intervalle en vue éloignée ; les marqueurs avancent par étapes. 250 ms par défaut.                                             |
| `telemetry.browser_map_poll_interval_ms`      | Intervalle de chargement des tuiles ; valeur actuelle : 5000 ms.                                                               |
| `telemetry.browser_debug_poll_interval_ms`    | Intervalle avec les réglages debug ouverts ; valeur actuelle : 1000 ms.                                                        |

Une page désactivée renvoie `404`. Une section désactivée disparaît du menu et ne charge pas ses données. Une couche désactivée n’est pas dessinée. Pour ajouter une couche, définissez sa valeur par défaut, inscrivez-la dans `tmaponline/web/src/core/modules.ts` et documentez-la ici. Les préférences du navigateur ne sont pas enregistrées dans ce YAML.

## compilation de l’interface

Les sources modifiables sont dans `tmaponline/web/src` : TypeScript décrit le comportement et SCSS, dans `styles`, l’apparence. Compilez avec :

```sh
npm ci
npm run format
npm run check:web
```

La compilation produit des modules ES et CSS minifiés dans `tmaponline/web/assets`. Python les sert en production sans Node.js. Les sections carte, joueurs, boss, serveur et activité restent des chunks dynamiques séparés avec leur propre CSS.

`npm ci` installe les versions du fichier lock. `npm run format` formate les sources. `npm run check:web` vérifie le code web et compile l’interface. Le résultat dans `assets` est généré : modifiez les sources dans `src` ou les ressources dans `static`.
