# Céleste — carte du ciel interactive (français)

Application web autonome inspirée de SkySafari / Stellarium. Code 100 % original ; aucune ressource graphique copiée.
Ouvrez simplement `index.html` (fonctionne en `file://`, sans serveur, hors ligne pour la carte).

## Fonctions
- **Carte du ciel plein écran** (canvas, projection stéréographique) : ~5 000 étoiles jusqu'à mag 6 (Hipparcos / Yale BSC via d3-celestial, embarquées dans `skydata.js`), couleurs selon B−V, noms français des étoiles et des 88 constellations, lignes des constellations, Voie lactée procédurale, écliptique, équateur, grille alt-azimutale, horizon et sol, points cardinaux (N, NE, E, SE, S, SO, O, NO), couleur du ciel selon la hauteur du Soleil.
- **Soleil, Lune (phase et orientation réelles du croissant), Mercure → Neptune** calculés avec astronomy-engine (MIT, embarqué localement) : positions topocentriques, réfraction atmosphérique, magnitudes.
- **Interaction** : glisser pour tourner, molette / pincement pour zoomer (1° à 185°), flèches du clavier et +/−, toucher/cliquer un objet → fiche (nom, type, magnitude, coordonnées, altitude/azimut, lever, passage au méridien, coucher, phase, distance, diamètre apparent, constellation…).
- **Temps** : « Maintenant » (temps réel), curseur ±3 jours, boutons ±1 h / ±1 j, lecture à ×1, ×60, ×600, ×3600, 1 j/s ou à rebours.
- **Mode nuit rouge** (préserve la vision nocturne), thème sombre.
- **Panneau « Ce soir »** : phase et illumination de la Lune, lever/coucher de la Lune, prochaines pleine/nouvelle Lune, coucher/lever du Soleil, crépuscules civil/nautique/astronomique, durée de nuit noire, planètes visibles avec heure, hauteur et direction optimales.
- **Conditions d'observation** (Open-Meteo, gratuit, sans clé) avec un sélecteur mémorisé **Maintenant / 6 prochaines heures**. *Maintenant* : nuages bas/moyens/hauts, humidité, vent, température, visibilité, risque de pluie, phase/illumination et hauteur de la Lune, état d'obscurité (jour, crépuscules, nuit noire) et **indice d'observation 0–5** (météo × obscurité − gêne lunaire) pour l'heure en cours, ou pour l'heure choisie si le curseur du temps est déplacé. *6 prochaines heures* : une ligne compacte par heure avec mini-barre d'indice, meilleure heure mise en évidence. Requête réduite (veille à J+2) ; hors ligne : dernière météo en cache (≤ 2 j) ou message clair, la partie astronomique reste calculée.
- **Recherche** (étoiles, désignations de Bayer « alpha Lyr », HIP, planètes, constellations en français ou en latin, sans accents). Entrée (ou « Rechercher/OK » du clavier mobile) choisit le premier résultat. Mode normal : animation jusqu'à l'objet, zoom adapté, fiche ouverte, laser verrouillé ; s'il est sous l'horizon, il est quand même centré avec la mention « sous l'horizon » et l'heure du prochain lever. Mode caméra : l'objet devient une **cible** — grande flèche au bord de l'écran, consignes en direct (« → Tournez à droite 45° », « ↑ Levez le téléphone 20° »), distance angulaire ; à l'entrée dans le viseur : verrouillage, flash vert et vibration (si disponible). Bouton « Effacer la cible ».
- **Lieu** : La Rochelle par défaut (46,16 N ; −1,15 E ; Europe/Paris), bouton de géolocalisation, saisie manuelle lat/lon, choix du fuseau. Réglages mémorisés (localStorage).
- **Mode caméra (réalité augmentée)** : vidéo de la caméra arrière en fond, ciel superposé, orientation pilotée par le gyroscope/boussole (iOS : `webkitCompassHeading`, Android : `deviceorientationabsolute`), lissage, projection gnomonique calée sur un champ de ~66° (réglable), correction manuelle du cap ±30°. Android (Chrome, Samsung Internet) : l'orientation absolue est prioritaire, repli automatique sur l'orientation relative avec curseur « Cap » élargi à ±180° et bouton **Calibrer** (calibrage sur étoile, ou option « je vise le Nord »). Correction portrait/paysage via `screen.orientation`. Caméra demandée en 1280×720 à 30 i/s (économie batterie), contraintes assouplies automatiquement si l'appareil les refuse. Repli gyroscope seul si la caméra est refusée ; message clair si les capteurs manquent.
- **Pointeur laser** : bouton dédié (icône viseur, vert = allumé, barré = éteint) sur la carte comme en mode caméra, synchronisé avec « Pointeur laser » dans Calques et mémorisé. Éteint : ni réticule, ni faisceau, ni fiche, et la recherche d'astre s'arrête (économie de calcul) ; le guidage vers un objet recherché continue de fonctionner. Allumé : un point laser vert lumineux avec faisceau au centre de l'écran. ~8 fois par seconde, l'astre le plus proche du centre dans un rayon de capture (~4° en mode caméra, proportionnel au champ sinon) est verrouillé — priorité Soleil/Lune/planètes, puis étoiles les plus brillantes, avec hystérésis anti-scintillement — et une fiche compacte s'affiche : nom, type spectral, constellation, magnitude, distance (parallaxe HYG pour les étoiles, astronomy-engine pour le système solaire), altitude/azimut, lever/coucher. Toucher la fiche ouvre la fiche complète. Si rien n'est visé : constellation pointée.
- **Optimisé pour tous les téléphones, y compris d'entrée de gamme (ex. Samsung Galaxy A15)** : rendu uniquement quand quelque chose change (aucune image redessinée vue immobile), mode caméra plafonné à ~30 i/s, résolution du canvas plafonnée à 2× et qualité adaptative (Haute / Moyenne / Économie : densité de pixels 2 → 1,5 → 1, magnitude et étiquettes réduites) choisie selon l'appareil (`deviceMemory`, `hardwareConcurrency`) puis ajustée selon le temps d'image mesuré ; réglage manuel « Qualité graphique » dans Calques. Voie lactée calculée sur une grille grossière et mise en cache, lignes/étiquettes de constellations précalculées à chaque pas de temps, étoiles hors champ éliminées et tracées par lots, pas d'allocation par étoile et par image, flou d'arrière-plan désactivé en mode allégé. Onglet masqué : rendu, capteurs et caméra coupés (relancés au retour) ; caméra arrêtée en quittant le mode caméra.
- Responsive : petits Android (360 px) à grands iPhone, paysage, unités `dvh`, zones de sécurité iOS/Android, cibles tactiles ≥ 44 px ; installable (manifest + service worker en HTTPS).

## Mode caméra sur iPhone : HTTPS obligatoire
Safari n'autorise la caméra et les capteurs de mouvement que sur une page **HTTPS** (ou localhost), jamais en `file://`.
Options :
1. **Serveur HTTPS local** (fourni) : sur un ordinateur du même Wi-Fi, `python3 serve_https.py` (crée un certificat auto-signé via openssl), puis ouvrir sur l'iPhone l'adresse affichée `https://<IP>:8443/` et accepter l'avertissement de certificat (« Afficher les détails » › « visiter ce site web »).
2. **Hébergement statique HTTPS gratuit** : déposer le dossier (ou le zip) sur GitHub Pages, Netlify Drop (app.netlify.com/drop), Cloudflare Pages, etc. Tout est statique : aucune configuration.
3. **Tunnel temporaire** : `python3 -m http.server 8000` puis `cloudflared tunnel --url http://localhost:8000` (URL https://….trycloudflare.com sans compte, valable tant que la commande tourne).
Au premier lancement, iOS demande l'accès « Mouvement et orientation » puis la caméra. Si refusé : Réglages › Apps › Safari › Mouvement et orientation.

## Mode avancé : satellites (caché)
- **Activer** : touchez 5 fois de suite le logo ✦ en haut à gauche → « Mode avancé activé ». Même geste pour désactiver. L'état est mémorisé (localStorage).
- Une section **Satellites** apparaît dans *Calques* : ISS, autres stations (Tiangong…), satellites brillants, Starlink (nombre limité selon l'appareil : 600 / 250 / 100 selon la qualité Haute / Moyenne / Économie).
- Orbites : CelesTrak (`gp.php?GROUP=stations|visual|starlink&FORMAT=tle`), mises en cache ~6 h ; hors ligne, la dernière copie est utilisée. Calcul SGP4 avec satellite.js (MIT, embarqué).
- Positions vraies vues depuis votre lieu ; satellite éclairé (brillant) ou dans l'ombre de la Terre (anneau gris), traînée courte. Sélection par toucher, pointeur laser ou recherche (« ISS »). Fiche : altitude, distance, vitesse, éclairé/ombre, magnitude estimée, prochain passage.
- **Pays / organisation** : drapeau + nom (champ OWNER du catalogue SATCAT de CelesTrak, `satcat/records.php?GROUP=…&FORMAT=json`, cache 7 jours ; Starlink = États-Unis/SpaceX sans téléchargement). Affiché dans la fiche, le panneau du laser et la liste des passages ; filtre par pays dans *Calques*. Sans données : « Pays inconnu ».
- **Prochains passages (24 h)** : lever / maximum / coucher, hauteur max, directions ; l'ISS est en tête. Toucher un passage règle l'heure et vise le satellite.

## Couche « Objets extrêmes »
- À activer dans *Calques* : 53 objets — trous noirs (Sgr A*, M87*, Cygnus X-1, V404 Cyg, Gaia BH1/2/3, A0620-00, GRS 1915+105…), rémanents et supernovae historiques (Crabe/1054, Cassiopée A, Tycho 1572, Kepler 1604, SN 1006, SN 185, SN 1987A, Vela, Dentelles du Cygne, IC 443, Simeis 147…), pulsars (Crabe, Vela, PSR B1919+21, Geminga, Hulse-Taylor…), magnétars (SGR 1806-20, SGR 1900+14, SGR 1935+2154), quasars (3C 273, 3C 48, TON 618…) et étoiles hors normes (Bételgeuse, Êta Carinae, VY CMa, WR 104, T CrB).
- Icône distincte par type, sélection au toucher, au laser et par la recherche (même couche désactivée). Fiche en français : type, distance, masse, magnitude et visibilité (œil nu / jumelles / télescope / invisible), description, sources.
- Coordonnées : SIMBAD (ICRS/J2000) ; pulsars : catalogue ATNF v2.6.1 ; distances et masses : publications citées dans chaque fiche (`extreme.js`).

## Catalogue de Messier (M1–M110)
Calques → « Catalogue de Messier » : les 110 objets avec un symbole par type (galaxie, amas ouvert/globulaire, nébuleuse diffuse/planétaire, rémanent, nuage stellaire M24, étoile double M40, astérisme M73). En zoomant, les grands objets sont tracés à leur vraie taille et, pour les galaxies, à leur vraie orientation (OpenNGC). Recherche « M31 », « Messier 31 », « NGC 224 » ou un nom (Andromède, Pléiades, Haltère/Dumbbell, Anneau, Tourbillon, Sombrero…), sélection au laser, fiche avec instrument conseillé, meilleur moment de la nuit, lever/coucher. « Marathon Messier » (Calques ou Ce soir) : objets à plus de 15° pendant la nuit, dans l'ordre où les viser.
M1 n'est pas dupliqué : c'est la nébuleuse du Crabe de la couche « Objets extrêmes », complétée par ses données Messier ; la fiche de M87 renvoie à son trou noir M87*. M102 : identification débattue, on retient NGC 5866 (galaxie du Fuseau).
Données : messier.js, généré par astro-app-build/messier/build.py (positions OpenNGC, validées automatiquement contre SIMBAD, Wikipédia/SEDS et d3-celestial : écart maximal 0,25° pour M45, sous la tolérance de la moitié de la taille de l'objet ; magnitude = médiane des sources).

## Téléphones sans gyroscope (ex. Samsung Galaxy A15)

Détection automatique (`devicemotion` sans `rotationRate`, ou orientation très bruitée) : badge discret **« Mode sans gyroscope »** dans le mode caméra ; le toucher affiche des conseils (faire un « 8 », retirer une coque aimantée, s'éloigner du métal) et un réglage Auto / Toujours / Jamais. Dans ce mode, l'orientation est refusionnée à partir de la gravité (accéléromètre → hauteur/inclinaison) et du cap boussole : filtre passe-bas adaptatif (fort à l'arrêt, rapide en mouvement), indépendant de la fréquence d'images, zone morte douce anti-tremblement, cap traité par angle signé (pas de saut 0/360°), rejet des pics magnétiques. Les téléphones avec gyroscope gardent le comportement habituel.

**Calibrer sur une étoile** : le bouton « Calibrer » propose 3 à 5 astres brillants au-dessus de l'horizon (Lune, planètes, étoiles brillantes) ou l'objet recherché. On centre le vrai astre dans le cercle jaune, on touche « Valider » : l'app calcule les décalages d'azimut et de hauteur et affiche l'erreur résiduelle. Une 2e étoile (à plus de 30° de la première) ajoute la correction d'inclinaison. Le calibrage est enregistré sur l'appareil (`localStorage`) et réinitialisable ; l'ancienne option « viser le Nord » reste disponible dans la même fenêtre.

## Télescope : GoTo, Sync et suivi (« Mode télescope »)

Céleste peut piloter une monture motorisée : **GoTo** vers l'objet touché sur la carte, **Sync** (recaler la monture sur une étoile centrée), **suivi sidéral** marche/arrêt, **flèches** de déplacement (maintenir appuyé, 4 vitesses), **parcage**, et un gros bouton **STOP**, toujours visible dans le mode télescope (aussi la touche Échap, et un bouton flottant « STOP télescope » hors du mode). La position du télescope s'affiche sur la carte (réticule vert). Pour l'objet visé, l'app envoie les coordonnées de la date (précession et nutation appliquées) ou J2000, selon le protocole ou le réglage.

« Autoguidage » veut dire ici : GoTo, puis suivi sidéral de la monture, avec un Sync pour corriger. **L'autoguidage par caméra de guidage (type PHD2) n'est pas pris en charge.**

### Qu'est-ce qui marche, et où ?
| Télescope / monture | Protocole | Android (Chrome) | PC (Chrome/Edge) | iPhone (Safari) |
|---|---|---|---|---|
| Celestron NexStar, SE, SLT, CPC, AVX, CGX… (raquette NexStar+) | NexStar | câble USB-OTG (Chrome 148+) ou Bluetooth série (138+) | câble USB/série, ou passerelle | via la passerelle sur un PC |
| Sky-Watcher avec raquette SynScan (câble) | NexStar (compatible) | idem | idem | via la passerelle |
| Meade LX200, LX90, LX600, ETX (AutoStar/AudioStar) | LX200 | idem | idem | via la passerelle |
| OnStep / OnStepX | LX200 | USB, Bluetooth série, Wi-Fi via passerelle | idem | Wi-Fi ou USB via la passerelle |
| Autres compatibles LX200 (10Micron, Gemini, Avalon…) | LX200 | idem (non vérifié) | idem | via la passerelle |
| Adaptateur Bluetooth BLE « série » (HM-10, Nordic UART) branché sur une raquette | NexStar ou LX200 | Web Bluetooth | Web Bluetooth | non (pas de Web Bluetooth) |
| iOptron, Celestron CPWI, SynScan App, toute monture ASCOM | ASCOM Alpaca | via la passerelle (ou en direct si le serveur autorise CORS, Chrome 142+) | idem | via la passerelle |
| KStars/Ekos, StellarMate, Astroberry | INDI (expérimental) | via la passerelle | via la passerelle | via la passerelle |
| Celestron Wi-Fi (SkyPortal, Evolution, Origin) | AUX propriétaire | ✗ (passer par CPWI + ASCOM Remote → Alpaca) | ✗ | ✗ |
| Sky-Watcher Wi-Fi (AZ-GTi, Star Adventurer GTi, adaptateur SynScan Wi-Fi) | UDP propriétaire | ✗ (passer par SynScan App + ASCOM Remote → Alpaca) | ✗ | ✗ |

Pourquoi l'iPhone passe toujours par un PC : Safari ne propose ni Web Serial ni Web Bluetooth. En plus, une page HTTPS (GitHub Pages) n'a pas le droit d'appeler un appareil `http://192.168…` (contenu mixte). La passerelle sert donc l'application elle-même sur le réseau local, et tout vient de la même adresse.

### La passerelle PC (`celeste_bridge.py`)
Un seul fichier, Python 3.8 ou plus récent, sous Windows, macOS, Linux ou Raspberry Pi. `pyserial` n'est nécessaire que pour les ports série/USB.
1. Installez Python, puis dans un terminal : `pip install pyserial`
2. Lancez `python3 celeste_bridge.py` depuis le dossier de l'application (Windows : `py celeste_bridge.py`).
3. Elle affiche une adresse, par exemple `http://192.168.1.20:8765/`. Sur l'iPhone, connecté au **même Wi-Fi**, ouvrez cette adresse dans Safari.
4. Calques › 🔭 Télescope : choisissez le télescope, puis la liaison « Passerelle PC → port série » (ex. `COM3` ou `/dev/ttyUSB0`, avec « Tester la passerelle » pour voir la liste des ports), « → TCP » (OnStep Wi-Fi : IP de la monture, port 9999 ; indiserver : port 7624) ou « → serveur Alpaca » (bouton « Rechercher »).
- Options : `--https` (certificat auto-signé à accepter une fois ; utile seulement pour le GPS ou la caméra sur iPhone via la passerelle), `--port 8765`, `--local-only`.
- Sécurité : seules les pages Céleste peuvent l'utiliser (même adresse, localhost, memecoinsphere.github.io). Le relais Alpaca est limité aux adresses du réseau local. Coupez-la (Ctrl+C) après la séance.
- Chrome sur Android ou PC peut aussi garder le site GitHub et viser la passerelle `http://IP-du-PC:8765`. Chrome 142+ demande alors l'autorisation « appareils du réseau local » : acceptez-la.

### Mode d'emploi rapide
Tout se fait dans un écran unique, le **Mode télescope** : la carte reste visible avec le réticule vert du télescope, et une feuille en bas (à gauche en paysage et sur ordinateur) présente 3 étapes. Les autres panneaux se ferment.
1. Faites l'alignement habituel sur la raquette (ou dans le logiciel de la monture) et vérifiez l'heure et le lieu dans Céleste.
2. Ouvrez le mode : Calques › « 🔭 Mode télescope », le bouton « Télescope » de la barre latérale (une fois connecté), ou « 🔭 Pointer avec le télescope » sur la fiche d'un astre (il est alors présélectionné).
3. **① Connexion** : choisissez le télescope et la liaison, puis **Connecter** (Web Serial ou Bluetooth : choisissez l'appareil dans la fenêtre du navigateur). L'étape se replie en une pastille « Connecté · … » ; touchez-la pour la rouvrir.
4. **② Choisir l'astre** : tapez un nom (Véga, Saturne, M31…), ou prenez-le dans « Visibles maintenant », ou touchez-le sur la carte (pas de grande fiche dans ce mode).
5. **③ Pointer** : le gros bouton indique l'astre et sa hauteur ; pendant le déplacement il montre la distance restante, une durée estimée et une barre de progression. À l'arrivée, si l'objet n'est pas centré : centrez-le avec les flèches (maintenir appuyé), puis **Sync**.
6. **STOP** (en haut de la feuille, toujours visible) arrête tout, immédiatement. « Quitter le mode télescope » revient à la carte normale, sans déconnecter. En fin de séance : « Plus » › Parquer, puis rouvrez la pastille › Déconnecter.

Retour (Android) ou geste retour (iPhone) ferme le mode. Sur ordinateur, Échap envoie STOP ; un 2e Échap dans les 2 secondes quitte le mode. Dans toute l'app, un seul panneau est ouvert à la fois : ouvrir un panneau ferme les autres et la fiche, et le retour ou Échap ferme celui du dessus.

Sécurité : les objets sous l'horizon sont refusés (la hauteur minimale se règle). Le Soleil est refusé sauf si vous cochez « filtre solaire certifié installé ». Une alerte s'affiche si l'objet est à moins de 20° du Soleil levé. Les flèches s'arrêtent dès qu'on relâche, et au plus tard après 20 s ; une monture parquée bloque GoTo et flèches. Le GoTo utilise toujours l'heure réelle, même si le curseur du temps est déplacé.

**Simulateur** : choisissez « Simulateur (aucun matériel) » pour tout essayer sans télescope. La monture fictive a une erreur de pointage volontaire de 0,4°/−0,3°, pour s'entraîner au Sync. La passerelle simule aussi LX200, NexStar, Alpaca et INDI (liaison « Passerelle PC → monture simulée »).

## Fichiers
`index.html`, `style.css`, `app.js` (code de l'application), `skydata.js` (catalogue embarqué, distances HYG CC BY-SA 4.0), `astronomy.browser.min.js` (astronomy-engine 2.1.19, MIT), `sw.js`, `manifest.webmanifest`, `icon.svg`, `serve_https.py`, `telescope.js` (contrôle de télescope), `celeste_bridge.py` (passerelle PC), `LICENSES.txt`.

## Limites connues
- Catalogue limité à mag ≈ 6 (≈ 5 000 étoiles) ; pas d'objets du ciel profond (Messier) ni de satellites/ISS.
- Positions des étoiles J2000 sans mouvement propre (écart négligeable à l'œil sur quelques décennies) ; précession/nutation et réfraction appliquées via astronomy-engine.
- Le cap boussole des téléphones est magnétique (déclinaison ≈ 0–1° en France) et sensible aux perturbations : utiliser le curseur « Cap ». Le champ caméra réel varie selon le modèle (curseur « Champ »).
- Télescope : protocoles écrits d'après les documentations publiques (NexStar Communication Protocol, Meade LX200 Command Set, ASCOM Alpaca, INDI) et testés contre des montures **simulées** (dans le navigateur, dans la passerelle, et via un vrai port série virtuel), **jamais sur du vrai matériel**. Le sens des flèches peut être inversé selon la monture. Pas de suivi d'un satellite. Arrêt du suivi impossible sur certaines raquettes LX200 Meade (pas de commande documentée). Pas de commande de parcage dans le protocole NexStar (parquez avec la raquette).
- Mode sans gyroscope : le lissage ajoute un retard d'environ 3° quand on tourne à 10°/s ; un calibrage sur étoile ne compense pas une perturbation magnétique qui change (voiture, rambarde) ; filtre testé sur des flux de capteurs simulés (profil A15), pas sur un vrai A15.
- L'indice 0–5 est une heuristique (la météo n'est disponible que de la veille à J+2) (nuages, humidité, visibilité, vent, pluie) ; il n'intègre ni la turbulence (seeing) ni la pollution lumineuse ; la Lune est indiquée à part.
- Voie lactée stylisée (procédurale), pas une photographie.
- Optimisations mesurées dans Chromium en émulation (Galaxy A15, processeur bridé ×4), pas sur un vrai téléphone : le rendu GPU réel d'un Mali-G57 diffère.
- Satellites : ombre de la Terre modélisée comme un cylindre (pénombre ignorée), magnitudes estimées (modèle de sphère diffuse), positions TEME non converties en J2000 pour le tracé (écart < 0,3°), Starlink masqués en lecture très accélérée, passages calculés par pas de 60 s (hauteur max ≥ 10°). CelesTrak peut limiter les téléchargements répétés.
