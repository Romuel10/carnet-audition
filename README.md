# Carnet d’audition mobile — v3.0.0-beta.5

Cette beta remplace entièrement le chemin audio précédent par un **enregistreur Android natif intégré au projet** (`MediaRecorder`). Elle ne dépend plus d’un plugin d’enregistrement tiers et n’utilise pas `getUserMedia()` dans l’APK Android.

## Construction GitHub Actions
Le workflow crée le projet Android puis `scripts/install-native-recorder.js` :
- ajoute `RECORD_AUDIO` au manifeste ;
- crée `NativeAudioRecorderPlugin.java` ;
- l’enregistre dans `MainActivity.java` ;
- compile ensuite l’APK debug.

## Test conseillé
1. Désinstaller l’ancienne beta après avoir exporté tout brouillon utile.
2. Installer le nouvel APK.
3. Ouvrir l’application : le bas de l’écran doit afficher `Audio natif prêt ... v3.0.0-beta.5`.
4. Appuyer sur **Question**, autoriser le micro si Android le demande, parler 5 secondes, puis **Arrêter**.
5. Vérifier que `Audio conservé` apparaît et que le lecteur permet la lecture.

Si l’application se ferme encore, la beta.5 mémorise aussi les erreurs JavaScript et affiche explicitement quand le module natif n’est pas présent. Pour un crash natif Android, un logcat sera nécessaire.


## Correctif beta.5

Cette version corrige la détection JavaScript du plugin natif dans une application Capacitor vanilla (sans bundler). Elle cherche d'abord `window.Capacitor.Plugins.NativeAudioRecorder`, puis utilise `registerPlugin()` ou `nativePromise()` comme secours.
