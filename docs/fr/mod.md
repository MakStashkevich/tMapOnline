# mod serveur tMapOnline

Le mod s’appelle `tMapOnline`. Il fonctionne dans le tModLoader serveur ; les joueurs n’ont pas besoin de l’installer séparément. Il envoie les données du jeu au service web et relaie Map Ping dans les deux sens.

## rôle du mod

Le mod ne dessine pas la carte et ne lance pas le site. Il lit des données du jeu, comme la position d’un joueur, et les envoie à tMapOnline. L’application les conserve et les affiche dans le navigateur. Placez un Map Ping dans le navigateur pour le voir en jeu, ou dans le jeu pour le voir dans le navigateur.

## responsabilités et limites

Le mod et tMapOnline échangent par TCP à `127.0.0.1`, l’adresse de l’ordinateur local, inaccessible aux machines externes sur ce port. Chaque message est une ligne JSON. Le mod n’est pas un serveur web et ne modifie pas le navigateur.

Les objets du jeu ne doivent être lus ou modifiés que pendant la boucle de jeu, quand tModLoader met à jour le monde. Les tâches réseau utilisent du texte de message déjà préparé et n’accèdent pas au monde depuis une autre tâche.

`TMapOnlineSystem` gère le démarrage et l’arrêt : il relie les gestionnaires d’événements du jeu, démarre les autres composants, prépare des snapshots à intervalles réguliers, reçoit Map Ping et ferme la connexion à l’arrêt.

| Responsabilité                                                           | Composant                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------- |
| Listener TCP, clients, JSONL, accusés de snapshot et commandes entrantes | `TelemetryStreamServer`                            |
| Snapshots des PNJ et entités du monde                                    | `WorldEntitySnapshotBuilder`                       |
| Apparence du joueur et export des textures de mod                        | `PlayerAppearanceSnapshotBuilder`                  |
| Scan de carte et modifications RGB/RGBA des tuiles                       | `WorldMapScanner`, `MapTileDataCapture`            |
| Noms des tuiles/murs et localisation                                     | `MapTileNameCatalog`                               |
| Détection des zones révélées de la carte joueur                          | `PlayerMapChangeRevealer`                          |
| Indicateurs de victoire vanilla et compteurs historiques                 | `BossProgressSnapshotReader`, `BossVictoryTracker` |
| Intégration propre à Calamity                                            | `CalamityBossProgressAdapter`                      |

RGB désigne les valeurs rouge, vert et bleu d’un pixel ; RGBA ajoute l’alpha (transparence). `CalamityBossProgressAdapter` ne sert qu’à l’intégration Calamity ; le reste du suivi des boss en est indépendant. Les noms du tableau sont ceux des sources. Gardez les accès aux objets de jeu dans la boucle du jeu ; les tâches réseau utilisent des messages préparés.

## transport et fiabilité

- Par défaut, le listener n’écoute que `127.0.0.1:38762`. Réglages : `server.telemetry_host` et `server.telemetry_port`.
- Les snapshots utilisent JSON Lines, schéma version `1`. Chaque ligne contient `snapshotId` et tMapOnline confirme sa réception sur la même connexion TCP.
- Les morts ont un ID stable, sont renvoyées jusqu’à confirmation et sont limitées par `storage.death_retention_seconds`.
- Le client tMapOnline se reconnecte après une rupture. Le listener garde le dernier état afin qu’un nouveau client reçoive immédiatement un snapshot récent.
- Un Web Map Ping est une commande avec coordonnées de tuile ; le mod le diffuse aux joueurs connectés. Les Map Ping du jeu reviennent comme événements avec ces coordonnées.
- Les préférences d’affichage du navigateur ne sont pas envoyées au mod. Les intervalles et directions des pings sont définis dans la configuration serveur.

Le mod ouvre le port et attend ; le service Python s’y connecte. Ensuite, les deux côtés peuvent envoyer des messages : le service envoie les Map Ping et accusés de réception, le mod transmet snapshots et événements du jeu.

Voir [telemetry.md](telemetry.md) pour le schéma et les endpoints. Si le sens ou le type d’un champ change, créez une nouvelle version de schéma et une période de compatibilité ; ne modifiez pas silencieusement la version 1.

## compilation

Lancez la commande depuis la racine du projet. Sur macOS, indiquez le dossier tModLoader par `TML_ROOT` :

```sh
TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py
```

Remplacez `/path/to/tModLoader` par le chemin du jeu installé. Le script compile le projet C# et crée `dist/tMapOnline.tmod`. Il utilise un dossier temporaire séparé, ne modifie pas le profil et n’installe pas le mod dans un serveur actif. La version tModLoader doit être la même pour la compilation et le serveur.

Pour charger le mod, copiez le `.tmod` dans le dossier `Mods` du profil serveur et ajoutez son ID à `Mods/enabled.json`. Le mod sera chargé au prochain démarrage. Vérifiez d’abord que les joueurs ont quitté le serveur.

## modifier le mod

1. Trouvez le gestionnaire d’événement dans `TMapOnlineSystem`. S’il contient trop de logique, déplacez-la dans une classe distincte à responsabilité claire.
2. Suivez chaque message de bout en bout : émetteur et récepteur côté service Python.
3. Lisez l’API Terraria dans la boucle de jeu. Transmettez des messages préparés aux tâches réseau.
4. Attribuez un ID unique aux événements importants et renvoyez-les jusqu’à l’accusé du service.
5. Compilez avec `python3 tools/build-mod.py` pour la version tModLoader cible.
6. Ne copiez pas le `.tmod` dans le profil d’un serveur actif et ne le redémarrez pas sans demande distincte d’installation et de lancement.

Un gestionnaire d’événement est du code appelé quand quelque chose arrive dans le jeu, par exemple la modification d’un bloc. L’ID unique permet au service de reconnaître un événement déjà reçu et d’éviter un doublon lors d’un nouvel envoi.
