# architecture de tMapOnline

Ce document explique comment tMapOnline est organisé et comment les données du jeu arrivent sur la carte dans le navigateur. Le service Python reçoit et stocke les données, puis les transmet à la carte web par une API. Le mod serveur les collecte dans tModLoader.

Le flux est le suivant : Terraria fournit des informations au mod, le mod les envoie au service, le service prépare une réponse et le navigateur la transforme en carte et en marqueurs. Ni le navigateur ni le service Python ne lisent directement la mémoire du processus Terraria.

En bref, le mod lit le jeu, le service Python reçoit les données et le navigateur les affiche. Une API est un ensemble d’adresses utilisées pour échanger des données. Un snapshot décrit l’état du jeu à un instant donné. Un cache conserve les données préparées pour éviter de les recalculer.

## projets et limites

```text
tMapOnline/                       # carte web, backend et mod
├── tmaponline/                  # paquet Python et mod tModLoader
│   ├── backend/                 # requêtes, réponses et fichiers web
│   ├── telemetry/               # connexion au mod du jeu
│   ├── sprite_renderer/         # textures du jeu et sprites PNG
│   ├── web/
│   │   ├── src/                 # sources modifiables de l’interface et de la carte
│   │   ├── assets/              # fichiers générés par la compilation
│   │   ├── static/              # images, polices et ressources source
│   │   └── world-map/           # page d’entrée de la carte
│   ├── tmodloader/
│   │   └── tMapOnline/          # code source C# du mod serveur
│   ├── config.py                # lecture, validation et valeurs YAML par défaut
│   └── runtime.py               # cycle de vie du service et du jeu
├── docs/                        # documentation
├── tests/                       # contrôles automatisés Python et web
├── tools/                       # commandes de compilation web et mod
├── config.example.yaml
├── package.json
└── pyproject.toml
```

`backend/http.py` traite les requêtes du navigateur et choisit la réponse. `backend/store.py` fournit une interface commune aux autres parties sans les obliger à connaître les fichiers de stockage. Dans `backend/services/`, les responsabilités sont séparées par sujet : `player_history` pour l’historique, `movement` pour les déplacements, `live_telemetry` pour les données récentes, `monitoring` pour l’état du serveur et `world_map` pour la carte.

Les formats et constantes communs se trouvent dans `store_common.py`. Le stockage est composé de petites parties spécialisées plutôt que d’une classe géante. Des verrous empêchent deux tâches de modifier les mêmes données simultanément. Le cache réutilise les résultats récemment préparés.

En JSONL, chaque message occupe une ligne. Le service le valide puis le convertit en modèle défini dans `models/telemetry.py`, une structure aux champs connus. Cela facilite l’utilisation des données et la recherche d’erreurs. Aux frontières du programme, les données sont converties vers les formats attendus par le navigateur et les autres clients.

Les intervalles de mise à jour sont définis dans `config.yaml` afin que les marqueurs mobiles et la grande carte ne soient pas envoyés à la même fréquence. tModLoader transmet séparément les positions, les entités et les couleurs de la carte. Entre deux messages, le mod conserve la dernière valeur de chaque catégorie.

La première requête `/api/world-map` renvoie les métadonnées — taille du monde et description des couches — sans les tuiles pixelisées. Une tuile est une portion rectangulaire de l’image finale. Le JSON complet avec toutes les tuiles peut être demandé explicitement avec `?tiles=0`, par exemple pour l’export.

Le navigateur dessine uniquement les objets visibles. Il crée un élément HTML avec un sprite pour chaque joueur ou objet affiché. Lors d’un déplacement ou d’un changement de zoom, il recalcule les marqueurs à garder à l’écran. Cela modifie seulement l’affichage et ne fait pas apparaître ou disparaître de PNJ dans le jeu.

L’image est répartie sur plusieurs niveaux de pyramide : les petites vues utilisent des tuiles d’aperçu, et le zoom affiche des détails plus précis. Le serveur fournit des tuiles PNG jusqu’à 256 × 256 pixels et ne prépare que celles qui intersectent la zone demandée. Le cache conserve les PNG prêts à l’emploi. Il est limité en nombre d’entrées et à 32 Mio au total. `/debug` affiche les accès au cache, les évictions et le temps de préparation.

Un canvas est une surface de dessin du navigateur. Au maximum, 16 tuiles et 4 Mio d’images décodées restent actifs. La carte et le masque d’exploration utilisent des canvas distincts : modifier le masque ne recharge donc pas les images de base. Lors d’un changement de niveau de détail, l’ancienne image reste affichée jusqu’à l’arrivée de la nouvelle. Les tuiles hors écran ne sont pas ajoutées au DOM. Le jeu de données complet n’est lu que lors d’un export explicite.

Les positions actuelles, morts, pièces et modifications de blocs arrivent par `/api/world-map/live`. SSE (Server-Sent Events) maintient une connexion HTTP ouverte afin que le serveur puisse transmettre les nouveautés sans requête séparée pour chaque objet. Le serveur envoie les données autour de la zone visible avec une petite marge ; le navigateur renouvelle l’abonnement après un déplacement important. Les pièces ne sont demandées qu’à fort zoom.

Lorsqu’un bloc change, le serveur sauvegarde la nouvelle donnée. Le navigateur ne recharge que l’image de la tuile concernée. Si une coordonnée change plusieurs fois avant la mise à jour suivante, seul son dernier état est conservé. Les autres tuiles seront actualisées à leur prochain affichage. `/debug` permet d’inspecter la fréquence et l’âge des snapshots, la taille des réponses et le temps de préparation des images.

`telemetry/stream.py` reçoit des snapshots JSON délimités par des retours à la ligne. Le mod collecte l’état du serveur et l’envoie à localhost. L’interface web ne contacte pas directement le processus du jeu : elle lit l’API partagée.

### rendu des sprites

`sprite_renderer/xnb_texture.py` vérifie les en-têtes XNB et lit les données RGBA de `Texture2D`. `sprite_renderer/lzx.py` décompresse les XNB, y compris les blocs de 32 Kio ; aucun paquet LZX externe ni runtime Java n’est nécessaire. `PlayerSpriteRenderer`, `NpcSpriteRenderer` et `MapItemSpriteRenderer` composent les avatars, portraits de PNJ/boss et icônes d’objets. Pillow sert uniquement à lire et écrire les PNG ; `StatusStore` gère le cache et les URL d’images. Le mod tModLoader reste en C#.

Pour reproduire les marqueurs du jeu, l’implémentation est comparée au code décompilé de la même version Terraria/tModLoader. La croix de mort provient de `Content/Images/MapDeath.xnb` ; `Main.DrawPlayerDeathMarker` la dessine selon `Player.lastDeathPostion`, centrée et à l’échelle de la carte. tMapOnline utilise donc le sprite original sans ombre ni contour artificiels. Le code décompilé sert de référence au développeur ; il n’est pas inclus dans ce dépôt et n’est pas requis pour exécuter le projet.

### composition et services tModLoader

Le flux de télémétrie envoie des snapshots à un intervalle configurable en ticks de jeu. Les morts sont capturées par `Player.KillMe`, reçoivent un ID unique et restent dans la file du mod jusqu’à confirmation de l’écriture par le service Python. Python applique une durée TTL configurable aux marqueurs stockés. La direction des joueurs et des PNJ est transmise séparément de leur position afin que l’interface reproduise le retournement horizontal du jeu.

`TMapOnlineSystem` est la racine du cycle de vie et de composition : il raccorde les hooks du jeu, crée les services et construit les snapshots JSON en conservant le contrat JSONL/API existant. Les détails sont confiés à des objets spécialisés.

La racine de composition crée les objets et les relie. Un service est un composant auxiliaire chargé d’une tâche. Un hook est un point où le jeu appelle le code du mod en réponse à un événement, par exemple une modification du monde.

- `TelemetryStreamServer` gère le listener TCP, les clients, JSONL, les accusés de réception des snapshots et les commandes entrantes.
- `WorldMapScanner` scanne une petite tuile de base par tick, prépare la palette et indique la progression.
- `PlayerMapChangeRevealer` construit la zone révélée autour d’un joueur et limite les captures répétées.
- `MapTileDataCapture` sérialise les identifiants de blocs et de murs et compresse la zone.
- `MapTileNameCatalog` résout les noms localisés des blocs et murs et les transmet progressivement.
- `PlayerAppearanceSnapshotBuilder` collecte l’apparence du joueur et exporte les textures nécessaires.
- `WorldEntitySnapshotBuilder` collecte les marqueurs de pylônes, PNJ/boss et pièces abandonnées.
- `BossProgressSnapshotReader` lit uniquement les indicateurs de progression vanilla.
- `CalamityBossProgressAdapter` interroge séparément le mod Calamity facultatif et ses indicateurs sauvegardés.
- `BossVictoryTracker` enregistre les victoires répétées dans `ApplicationData/tMapOnline/boss-victories.json`.

Les services ne reçoivent que l’état dont ils ont besoin. La lecture et la modification de `Main`, `Player`, `NPC`, des tuiles, de la palette et de la carte se font sur le thread du jeu. Le transport en arrière-plan reçoit des lignes JSONL sérialisées et immuables, pas des objets vivants. `Main.dedServ` n’est pas remplacé pour initialiser la carte.

## structure de l’interface web

`web/world-map/index.html` est le seul point d’entrée de la carte tMapOnline. `/` et `/world-map` ouvrent la même carte ; l’ancien écran de surveillance est désactivé. Les sources de l’interface, de la carte, des sections et des styles sont dans `web/src`. `npm run build` compile et minifie TypeScript en modules ES et SCSS en CSS dans `web/assets`. En production, Python sert ces fichiers sans Node.js.

`src/app-shell.ts` contient `TMapOnlineApplication` : il charge les données d’une section à la demande et l’ouvre dans un dialogue pixelisé. La carte occupe immédiatement l’écran. `MapActionMenu` construit les catégories verticales et leur sous-menu voisin ; `PixelModal` gère la fermeture, Escape et le focus clavier. Les joueurs et itinéraires se règlent dans la fenêtre des joueurs et actualisent immédiatement les couches. `MapZoomControls` relie les boutons pixelisés et la vue du monde entier au contrôleur. Les sections `src/sections/{world,players,bosses,server,activity}.ts` et leurs styles ne sont chargés qu’à l’ouverture.

Les catégories regroupent les joueurs et itinéraires, les données du monde et victoires de boss, l’état du serveur et l’activité ; les diagnostics sont aussi disponibles sur `/debug`. Les sections sont contrôlées par `site.sections`. Le backend les sert via `/api/section-data?section=...`. Le progrès des boss comprend les boss actifs, indicateurs vanilla, compteur de victoires répétées compatible et statut Calamity facultatif. `/api/status` est conservé pour compatibilité et n’alimente pas les fenêtres modales. Les mises à jour de la carte continuent lorsqu’une fenêtre est ouverte.

L’interface utilise les modules ES natifs sans runtime frontend ni bibliothèque de composants. La séparation est explicite : l’enveloppe gère le menu et les dialogues, le SCSS de chaque section son style pixelisé, et `mount(root)` la requête et l’affichage des données. esbuild et Sass s’exécutent pendant le développement ou le paquetage. Les journaux, l’historique des joueurs et les statistiques ne sont chargés qu’à l’ouverture de la fenêtre correspondante.

### objets TypeScript et responsabilités

`src/map/world-map.ts` reste la racine de composition de la page : elle active les fonctions configurables, relie le cycle des données à l’affichage et actualise la couche carte. Les objets distincts gèrent les mécanismes isolés :

- `MapSnapshotCache` — IndexedDB et restauration de l’état sauvegardé.
- `MapChunkCodec` — décodage et assemblage des tuiles et mises à jour.
- `MapPyramidLayerRenderer` — niveau de détail, chargement des PNG visibles, annulation des anciennes requêtes HTTP et priorité autour du point de zoom ; sans point actif, le centre du viewport passe en premier.
- `MapExplorationMask` — fusion des cartes importées et itinéraires dans le masque exploré.
- `MapImageExporter` — export PNG de la carte avec le masque d’exploration si activé.
- `MapViewportController` — zoom, déplacement, gestes et événements viewport ; il transmet au renderer la coordonnée du monde sous le point de zoom pour la charger en priorité.
- `MapZoomControls` — boutons de zoom et retour à la vue du monde entier.
- `MapEntityLayer` — marqueurs joueurs, PNJ/boss, pièces, pylônes et point d’apparition ; les coordonnées hors écran ne créent ni sprites DOM ni boucles d’animation.
- `MapTooltipController` — délai de survol, cache des informations de blocs et infobulle.
- `MapPlayerPathService` — normalisation de l’historique, cache des itinéraires et séparation des segments autour des téléportations.
- `MapRouteLayer` — itinéraires SVG et marqueurs de position actuelle.
- `MapDiagnosticsPanel` — état du scanner et diagnostics.

Ajoutez les fonctions de carte dans des objets réutilisables, avec un rôle clair et des dépendances explicites. Ne remettez pas le codec, IndexedDB, les gestes ou le balisage des marqueurs dans `world-map.ts`. Séparez les flux trop grands quand vous modifiez la fonctionnalité correspondante ; évitez les classes wrappers sans état ni comportement propre.

Commandes frontend : `npm ci` installe les versions verrouillées, `npm run typecheck` vérifie TypeScript, `npm run build` met à jour `web/assets`, et `npm run check:web` exécute les deux contrôles. Recompilez les assets après toute modification source avant de lancer ou empaqueter tMapOnline. Pyright vérifie Python en mode `strict` (Pylance utilise le même moteur) : `npm run check:python`. Pour l’environnement local, exécutez `python3 -m pip install -r requirements-dev.txt`, puis `npm ci`. Vérification complète : `npm run check:all`. Quatre services existants utilisant des stockages JSON flexibles désactivent uniquement le diagnostic des types inconnus ; leurs champs sont toujours vérifiés à l’exécution et le reste des règles strictes demeure actif.

## état et configuration

`config.yaml` définit le démarrage et les pages/sections activées. Le thème, les joueurs/couches choisis et la position de la carte sont stockés séparément dans `localStorage`. Les données personnelles et caches résident dans `~/Library/Application Support/tMapOnline`, pas dans le dépôt. Le schéma API et télémétrie est décrit dans [telemetry.md](telemetry.md).

La configuration sépare le démarrage du service de l’activation des pages et composants. Les préférences d’affichage de l’utilisateur restent distinctes des paramètres serveur.
