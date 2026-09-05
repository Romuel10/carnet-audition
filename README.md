# Carnet d’audition — Assistant PV Gendarmerie v3.1.0-beta.3

## Correctif principal : texte immédiat + arrêt rapide

Cette version corrige les deux problèmes observés sur Android :

1. **La transcription directe ne produisait aucun texte.** La beta.2 essayait d’injecter notre flux `AudioRecord` dans `SpeechRecognizer`. Certains moteurs Android/Speech Services n’acceptent pas correctement ce flux. La beta.3 utilise désormais le **service de dictée Android directement**, en parallèle avec un enregistreur audio non privé afin de permettre le partage du microphone sur Android récent.
2. **L’arrêt restait longtemps sur « sauvegarde… ».** La beta.2 convertissait immédiatement tout le WAV en Base64. La beta.3 garde le fichier WAV natif sur le téléphone et ne le convertit qu’au moment de l’export `.pvaud`. L’arrêt doit donc être beaucoup plus rapide.

## Mode recommandé

- `Mode de transcription` : **Rapide : dictée Android + audio**
- `Langue` : **Malagasy (mg-MG)**
- `Transcription en direct` : activée
- `Forcer/privilégier hors ligne` : **désactivé** pour laisser Android utiliser son meilleur moteur vocal Malagasy
- `Réviser automatiquement avec Whisper` : **désactivé** par défaut, car Whisper sur un téléphone peu puissant peut prendre plusieurs secondes ou davantage.

Whisper reste disponible comme révision facultative et hors ligne. Le fichier audio original est toujours conservé.

## Installation / mise à jour

Copier cette version dans le dépôt Termux puis :

```bash
cd ~/carnet-audition
cp -r /sdcard/Download/carnet_beta9/. .
npm install
git add -A
git commit -m "Speed up live Malagasy dictation beta3"
git push origin main
```

Dans GitHub Actions, récupérer l’artifact :

`Carnet-audition-v3.1-beta3-debug-apk`

## Test conseillé

1. Installer la beta.3.
2. Vérifier `v3.1 beta.3` en haut.
3. Choisir `Malagasy (mg-MG)`.
4. Laisser le mode hors ligne **décoché**.
5. Appuyer sur `Question` et parler 5 à 10 secondes.
6. Le texte doit commencer à apparaître pendant la parole ou après une courte pause.
7. Appuyer sur `Arrêter` : le WAV doit être finalisé rapidement.
8. Activer Whisper seulement si vous souhaitez ensuite améliorer le texte.

## Confidentialité

Le mode direct Android peut, selon le moteur installé sur le téléphone, utiliser un service distant. Pour une audition qui doit rester strictement hors ligne, choisissez le mode `Privé : audio + Whisper après l’arrêt`. Ce mode est plus lent mais garde la reconnaissance locale après téléchargement du modèle.

## Export

L’export `.pvaud` reste compatible avec Assistant PV PC. Les données audio ne sont converties en Base64 qu’au moment où vous appuyez sur **Enregistrer l’audition (.pvaud)**.
