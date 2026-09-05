# Carnet d’audition — Assistant PV Gendarmerie v3.0.0-beta.6

Cette version ajoute trois fonctions demandées pour l’usage terrain :

1. **Audio + transcription en direct** : sur Android 13/API 33 et plus, l’application capture une seule fois le microphone avec `AudioRecord`, conserve un fichier WAV et transmet le même flux PCM au moteur `SpeechRecognizer` Android. Les résultats partiels sont affichés dans la zone Question/Réponse pendant que la personne parle.
2. **Profil enquêteur persistant** : grade, nom et prénoms, qualité, fonction et unité sont enregistrés localement sur le téléphone. Le bouton **Modifier** permet de les changer. Une nouvelle audition conserve ce profil.
3. **Fichier d’audition `.pvaud`** : le bouton **Enregistrer l’audition (.pvaud)** crée le fichier complet contenant texte + audios + profil. Sur Android 10+, il est enregistré dans `Téléchargements/AssistantPV/` pour être copié sur le PC et importé dans Assistant PV Gendarmerie.

## Transcription

- Langues proposées : Malagasy `mg-MG` et Français `fr-FR`.
- Le réglage « Privilégier hors ligne » transmet la préférence au moteur vocal Android. Le moteur installé sur le téléphone peut toutefois ignorer cette préférence ou ne pas disposer du modèle demandé.
- La transcription reste toujours modifiable avant export.
- Si le moteur vocal n’accepte pas l’injection du flux audio ou la langue choisie, l’enregistrement audio continue : seule la transcription live devient indisponible.

## Compilation APK avec GitHub Actions

Le dépôt contient `.github/workflows/build-android.yml`.

Après copie de cette beta dans votre dépôt :

```bash
cd ~/carnet-audition
cp -r /sdcard/Download/carnet_beta6/. .
npm install
git add -A
git commit -m "Add live transcription profile and pvaud save beta6"
git push origin main
```

Puis télécharger l’artifact **Carnet-audition-debug-apk** depuis GitHub Actions.

## Test conseillé

1. Enregistrer le profil enquêteur.
2. Choisir `Malagasy (mg-MG)`.
3. Appuyer sur **Question** et parler 5 à 10 secondes : le texte doit apparaître progressivement.
4. Appuyer sur **Arrêter** et vérifier le lecteur audio.
5. Faire de même avec **Réponse**.
6. Appuyer sur **Enregistrer l’audition (.pvaud)**.
7. Vérifier le fichier dans `Téléchargements/AssistantPV/` puis le transférer par USB au PC.
