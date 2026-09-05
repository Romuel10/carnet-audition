# Carnet d’audition — Assistant PV Gendarmerie v3.1.0-beta.1

Cette version transforme la beta.6 en **dictée hybride Malagasy** : le texte apparaît pendant la parole grâce au moteur vocal Android, puis l’audio original peut être relu localement par Whisper pour améliorer le texte final.

## Nouveautés v3.1

### 1. Texte immédiat + audio original
- Un seul flux microphone est capturé en WAV 16 kHz mono.
- Sur Android 13/API 33+, ce même flux est injecté dans `SpeechRecognizer` pour afficher les résultats partiels dans la zone **Question** ou **Réponse** pendant que la personne parle.
- Le vocabulaire du dossier (profil, lieu, identité et dictionnaire) est transmis comme contexte quand Android le permet.
- La confiance du résultat direct est affichée si le moteur Android la fournit.

### 2. Révision IA Whisper entièrement locale
- Nouveau moteur natif basé sur **whisper.cpp v1.9.1**.
- Langue imposée à `mg` pour Malagasy ou `fr` pour Français.
- Après l’arrêt de Question/Réponse, Whisper peut relire exactement le fichier WAV enregistré et remplacer le texte direct par une transcription améliorée.
- L’audio original et, si souhaité, la transcription directe restent conservés dans le `.pvaud` pour comparaison.

Deux modèles quantifiés sont proposés et téléchargés à la demande :
- **Base Q5** (`ggml-base-q5_1.bin`, ~57 MiB) : recommandé pour les téléphones modestes ;
- **Small Q5** (`ggml-small-q5_1.bin`, ~181 MiB) : plus lourd et généralement plus précis, mais plus lent et plus gourmand en mémoire.

Le modèle est stocké dans le dossier privé de l’application. Le téléchargement nécessite Internet une seule fois ; les révisions suivantes se font sans Internet.

### 3. Dictionnaire adapté aux auditions
Le champ **Dictionnaire prioritaire** contient déjà des termes juridiques et malagasy. Vous pouvez ajouter :
- noms et prénoms ;
- grades et unités ;
- fokontany, communes et districts ;
- termes juridiques ;
- mots mal reconnus fréquemment.

Le dictionnaire sert à la fois de biais contextuel pour Android et de contexte initial pour Whisper.

### 4. Apprentissage local des corrections
Si **Apprendre localement les mots que je corrige** est activé, après une correction manuelle l’application ajoute au dictionnaire local jusqu’à quelques mots nouveaux absents de la transcription automatique. Ils seront donc proposés comme contexte lors des auditions suivantes.

### 5. Trois modes
- **Intelligent : direct + Whisper local** : recommandé. Texte immédiat puis révision locale après l’arrêt.
- **Direct Android seulement** : texte immédiat sans seconde passe Whisper.
- **Privé : Whisper local après l’arrêt** : aucune dictée Android en direct ; uniquement l’audio et la transcription locale Whisper après l’arrêt.

> Le moteur vocal Android peut utiliser un service réseau selon le téléphone, même lorsque « privilégier hors ligne » est activé. Pour un usage où aucun service distant n’est autorisé, utilisez le mode **Privé : Whisper local après l’arrêt**.

## Compilation APK via GitHub Actions

Le workflow `.github/workflows/build-android.yml` :
1. installe Node 22, Java 21, NDK 25.2 et CMake 3.22.1 ;
2. récupère `whisper.cpp` v1.9.1 ;
3. génère le projet Capacitor Android ;
4. injecte les plugins natifs audio + Whisper ;
5. compile l’APK `arm64-v8a` ;
6. publie `app-debug.apk` comme artifact.

Depuis Termux, après avoir décompressé le dossier `carnet_beta7` dans Download :

```bash
cd ~/carnet-audition
cp -r /sdcard/Download/carnet_beta7/. .
npm install
git add -A
git commit -m "Add Malagasy smart dictation Whisper v3.1"
git push origin main
```

Puis : **GitHub → carnet-audition → Actions → dernière exécution → Artifacts → Carnet-audition-v3.1-beta1-debug-apk**.

## Premier test recommandé

1. Installer le nouvel APK et ouvrir l’application.
2. Vérifier que le haut affiche **v3.1 beta.1**.
3. Dans **Dictée intelligente Malagasy**, garder **Base Q5** puis toucher **Télécharger le modèle IA**. Attendre `Modèle IA local prêt ✓`.
4. Choisir **Intelligent : direct + Whisper local** et `Malagasy (mg-MG)`.
5. Appuyer sur **Question** et parler 5 à 10 secondes. Le texte direct doit apparaître progressivement si le moteur Android le prend en charge.
6. Appuyer sur **Arrêter**. L’audio est conservé, puis le statut indique **révision IA Malagasy en cours**. Le texte final est ensuite remplacé par la transcription Whisper.
7. Corriger un nom ou un lieu si nécessaire puis sortir du champ : les nouveaux mots peuvent être ajoutés au dictionnaire local.
8. Faire le même test avec **Réponse**.
9. Utiliser **Enregistrer l’audition (.pvaud)** puis importer le fichier dans Assistant PV Gendarmerie sur le PC.

## Important

- La transcription automatique est une aide à la saisie : elle doit être relue avant validation d’un PV.
- L’audio original est conservé afin de permettre la vérification du texte.
- Le modèle Whisper fourni ici est le modèle multilingue officiel quantifié, avec langue `mg` et contexte juridique. Le projet est maintenant structuré pour pouvoir remplacer ultérieurement ce modèle par un modèle fine-tuné spécifiquement sur des auditions Malagasy si un fichier GGML compatible est préparé et validé.
