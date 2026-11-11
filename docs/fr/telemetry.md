# télémétrie et API

La télémétrie correspond aux données de jeu que le mod envoie automatiquement au service web. Celui-ci les reçoit, les valide, conserve l’historique utile et prépare les réponses du navigateur. Map Ping emprunte le même canal du jeu vers le navigateur et du navigateur vers le jeu.

## flux du mod

Le mod ouvre le port `server.telemetry_port` sur l’adresse `server.telemetry_host` et attend une connexion. Le client Python se connecte en TCP, un lien réseau entre deux programmes. Une fois connecté, le mod transmet les données. Chaque ligne JSON contient un enregistrement : ce format s’appelle JSONL. `schemaVersion: 1` indique les règles de lecture. Les enregistrements contiennent l’état du serveur, du monde, des joueurs, des PNJ et des objets de carte. Le client Python réessaie automatiquement après une coupure et ignore une ligne invalide pour continuer.

Chaque enregistrement complet (snapshot, état à un instant donné) possède un `snapshotId`. Après lecture et sauvegarde réussies, le client Python renvoie un ACK, courte confirmation d’acceptation : `{"ackSnapshotId":123}`. Un événement de mort a son propre `id`, car il peut arriver entre deux snapshots. Le mod renvoie les événements non confirmés et ne les retire de la file qu’après un ACK. `storage.death_retention_seconds` fixe la conservation des marqueurs ; `0` désactive le nettoyage automatique.

Les joueurs et PNJ transmettent leur direction depuis `Player.direction` et `NPC.spriteDirection`, afin que le navigateur retourne correctement le sprite. Le champ facultatif `respawnPending` indique que le joueur est mort ou que sa position n’a pas encore changé après réapparition. Tant qu’il vaut `true`, la carte masque le marqueur du joueur à l’ancienne position, mais conserve la croix de mort.

Le payload est le contenu d’un enregistrement envoyé par le mod. Pour une modification compatible, ajoutez des champs facultatifs : l’ancien destinataire peut les ignorer. Si le sens ou le type d’un champ existant change, augmentez la version de schéma et faites lire les deux versions pendant la transition. N’incluez ni mot de passe, ni jeton, ni secret.

## endpoints HTTP

HTTP est le moyen habituel pour qu’un navigateur demande une page ou des données au serveur. `GET` lit, `POST` envoie et `DELETE` supprime des données indiquées. Le texte après `?` contient les paramètres : `x=10&y=20`, par exemple, donne les coordonnées d’une tuile. Dans ce tableau, `x` et `y` sont exprimés en tuiles du jeu.

Dans les adresses, `id` désigne un joueur, `world` le nom du monde, `days` le nombre de jours d’historique et `since` le point à partir duquel demander uniquement les changements récents. Un feature flag indique si une fonction est disponible.

| Endpoint                                                   | Fonction                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/status`                                          | Résumé du serveur, des joueurs, des boss et de l’historique.           |
| `GET /api/world-map`                                       | Métadonnées et couches sans tuiles pixelisées complètes.               |
| `GET /api/world-map?tiles=0`                               | JSON complet compatible avec les tuiles de pixels.                     |
| `GET /api/world-map?since=...`                             | Diff des mises à jour de carte.                                        |
| `GET /api/world-map/tile-info?x=...&y=...`                 | Description localisée d’un bloc ou mur.                                |
| `GET /api/world-map/exploration?id=...&world=...`          | Image d’exploration du joueur.                                         |
| `POST /api/world-map/import-player-map?id=...`             | Importe un `.map` depuis debug et fusionne les nouveaux tiles révélés. |
| `POST /api/world-map/export-player-map?id=...`             | Exporte un `.map` depuis les données sauvegardées.                     |
| `DELETE /api/world-map/import-player-map?id=...&world=...` | Efface uniquement la partie importée de la carte.                      |
| `GET /api/resource-history?days=...`                       | Historique des ressources du serveur.                                  |
| `GET /healthz`                                             | Vérification locale du serveur HTTP.                                   |
| `GET /api/site-config`                                     | Feature flags de l’interface.                                          |

Les fichiers statiques de l’interface (CSS, JavaScript et images permanentes) sont dans `/assets/`. Les images de joueurs, PNJ et boss sont servies par des adresses API distinctes depuis le répertoire de données.

Pour vérifier une adresse manuellement, ouvrez-la dans le navigateur ou envoyez une requête en ligne de commande. Commencez par `/healthz` : une réponse correcte confirme le service HTTP, mais pas la connexion du mod ni la réception de la carte. Vérifiez `/api/status` et `/api/world-map`.
