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
- **Prévisions sur 7 jours, heure par heure** (Open-Meteo, gratuit, sans clé) : nuages bas/moyens/hauts, humidité, visibilité, vent, pluie → **indice de qualité du ciel 0–5** sous forme de graphique, bandes de nuit astronomique, synthèse par nuit et meilleur créneau. Hors ligne : dernières données en cache (≤ 3 j) ou message clair, la carte reste fonctionnelle.
- **Recherche** (étoiles, désignations de Bayer « alpha Lyr », HIP, planètes, constellations en français ou en latin, sans accents). Entrée (ou « Rechercher/OK » du clavier mobile) choisit le premier résultat. Mode normal : animation jusqu'à l'objet, zoom adapté, fiche ouverte, laser verrouillé ; s'il est sous l'horizon, il est quand même centré avec la mention « sous l'horizon » et l'heure du prochain lever. Mode caméra : l'objet devient une **cible** — grande flèche au bord de l'écran, consignes en direct (« → Tournez à droite 45° », « ↑ Levez le téléphone 20° »), distance angulaire ; à l'entrée dans le viseur : verrouillage, flash vert et vibration (si disponible). Bouton « Effacer la cible ».
- **Lieu** : La Rochelle par défaut (46,16 N ; −1,15 E ; Europe/Paris), bouton de géolocalisation, saisie manuelle lat/lon, choix du fuseau. Réglages mémorisés (localStorage).
- **Mode caméra (réalité augmentée)** : vidéo de la caméra arrière en fond, ciel superposé, orientation pilotée par le gyroscope/boussole (iOS : `webkitCompassHeading`, Android : `deviceorientationabsolute`), lissage, projection gnomonique calée sur un champ de ~66° (réglable), correction manuelle du cap ±30°. Repli gyroscope seul si la caméra est refusée ; message clair si les capteurs manquent.
- **Pointeur laser** : en mode caméra (et en option « Pointeur laser » dans Calques pour le mode normal), un point laser vert lumineux avec faisceau au centre de l'écran. ~8 fois par seconde, l'astre le plus proche du centre dans un rayon de capture (~4° en mode caméra, proportionnel au champ sinon) est verrouillé — priorité Soleil/Lune/planètes, puis étoiles les plus brillantes, avec hystérésis anti-scintillement — et une fiche compacte s'affiche : nom, type spectral, constellation, magnitude, distance (parallaxe HYG pour les étoiles, astronomy-engine pour le système solaire), altitude/azimut, lever/coucher. Toucher la fiche ouvre la fiche complète. Si rien n'est visé : constellation pointée.
- Responsive iPhone / desktop, zones de sécurité iOS, installable (manifest + service worker en HTTPS).

## Mode caméra sur iPhone : HTTPS obligatoire
Safari n'autorise la caméra et les capteurs de mouvement que sur une page **HTTPS** (ou localhost), jamais en `file://`.
Options :
1. **Serveur HTTPS local** (fourni) : sur un ordinateur du même Wi-Fi, `python3 serve_https.py` (crée un certificat auto-signé via openssl), puis ouvrir sur l'iPhone l'adresse affichée `https://<IP>:8443/` et accepter l'avertissement de certificat (« Afficher les détails » › « visiter ce site web »).
2. **Hébergement statique HTTPS gratuit** : déposer le dossier (ou le zip) sur GitHub Pages, Netlify Drop (app.netlify.com/drop), Cloudflare Pages, etc. Tout est statique : aucune configuration.
3. **Tunnel temporaire** : `python3 -m http.server 8000` puis `cloudflared tunnel --url http://localhost:8000` (URL https://….trycloudflare.com sans compte, valable tant que la commande tourne).
Au premier lancement, iOS demande l'accès « Mouvement et orientation » puis la caméra. Si refusé : Réglages › Apps › Safari › Mouvement et orientation.

## Fichiers
`index.html`, `style.css`, `app.js` (code de l'application), `skydata.js` (catalogue embarqué, distances HYG CC BY-SA 4.0), `astronomy.browser.min.js` (astronomy-engine 2.1.19, MIT), `sw.js`, `manifest.webmanifest`, `icon.svg`, `serve_https.py`, `LICENSES.txt`.

## Limites connues
- Catalogue limité à mag ≈ 6 (≈ 5 000 étoiles) ; pas d'objets du ciel profond (Messier) ni de satellites/ISS.
- Positions des étoiles J2000 sans mouvement propre (écart négligeable à l'œil sur quelques décennies) ; précession/nutation et réfraction appliquées via astronomy-engine.
- Le cap boussole des téléphones est magnétique (déclinaison ≈ 0–1° en France) et sensible aux perturbations : utiliser le curseur « Cap ». Le champ caméra réel varie selon le modèle (curseur « Champ »).
- L'indice 0–5 est une heuristique (nuages, humidité, visibilité, vent, pluie) ; il n'intègre ni la turbulence (seeing) ni la pollution lumineuse ; la Lune est indiquée à part.
- Voie lactée stylisée (procédurale), pas une photographie.
