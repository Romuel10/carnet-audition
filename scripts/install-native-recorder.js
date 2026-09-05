const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const androidRoot = path.join(root, 'android');
const manifest = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
const javaDir = path.join(androidRoot, 'app', 'src', 'main', 'java', 'mg', 'assistantpv', 'carnet');
const mainActivity = path.join(javaDir, 'MainActivity.java');
const pluginFile = path.join(javaDir, 'NativeAudioRecorderPlugin.java');

if (!fs.existsSync(manifest)) {
  console.error('AndroidManifest.xml introuvable. Lancez d’abord npx cap add android.');
  process.exit(1);
}

let manifestText = fs.readFileSync(manifest, 'utf8');
const recordPerm = '<uses-permission android:name="android.permission.RECORD_AUDIO" />';
if (!manifestText.includes('android.permission.RECORD_AUDIO')) {
  manifestText = manifestText.replace(/<manifest([^>]*)>/, `<manifest$1>\n    ${recordPerm}`);
}
// L'ancien correctif MODIFY_AUDIO_SETTINGS n'est pas nécessaire pour MediaRecorder natif.
manifestText = manifestText.replace(/\s*<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"\s*\/>\s*/g, '\n');
fs.writeFileSync(manifest, manifestText);

fs.mkdirSync(javaDir, { recursive: true });

const pluginSource = `package mg.assistantpv.carnet;

import android.Manifest;
import android.media.MediaRecorder;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;

@CapacitorPlugin(
    name = "NativeAudioRecorder",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class NativeAudioRecorderPlugin extends Plugin {
    private MediaRecorder recorder;
    private File currentFile;
    private long startedAt = 0L;
    private boolean recording = false;

    @PluginMethod
    public void diagnostics(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("permission", String.valueOf(getPermissionState("microphone")));
        ret.put("recording", recording);
        ret.put("sdk", Build.VERSION.SDK_INT);
        ret.put("manufacturer", Build.MANUFACTURER);
        ret.put("model", Build.MODEL);
        call.resolve(ret);
    }

    @PluginMethod
    public void startRecording(PluginCall call) {
        if (recording) {
            call.reject("Un enregistrement est déjà en cours.", "ALREADY_RECORDING");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermsCallback");
            return;
        }
        beginRecording(call);
    }

    @PermissionCallback
    private void microphonePermsCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            beginRecording(call);
        } else {
            call.reject("Autorisation du microphone refusée.", "MISSING_PERMISSION");
        }
    }

    private void beginRecording(PluginCall call) {
        try {
            File dir = new File(getContext().getFilesDir(), "audios");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("Impossible de créer le dossier audio.", "STORAGE_ERROR");
                return;
            }
            currentFile = new File(dir, "rec-" + System.currentTimeMillis() + ".m4a");

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                recorder = new MediaRecorder(getContext());
            } else {
                recorder = new MediaRecorder();
            }
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(96000);
            recorder.setAudioSamplingRate(44100);
            recorder.setOutputFile(currentFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            startedAt = System.currentTimeMillis();
            recording = true;

            JSObject ret = new JSObject();
            ret.put("value", true);
            ret.put("path", currentFile.getAbsolutePath());
            call.resolve(ret);
         } catch (Exception error) {
            safeRelease();
            if (currentFile != null && currentFile.exists()) currentFile.delete();
            call.reject("Démarrage du microphone impossible : " + safeMessage(error), "FAILED_TO_RECORD", error);
        }
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        if (!recording || recorder == null) {
            call.reject("Aucun enregistrement en cours.", "RECORDING_HAS_NOT_STARTED");
            return;
        }

        File file = currentFile;
        long duration = Math.max(0L, System.currentTimeMillis() - startedAt);
        try {
            recorder.stop();
            safeRelease();
            recording = false;

            if (file == null || !file.exists() || file.length() == 0L) {
                if (file != null && file.exists()) file.delete();
                call.reject("L’enregistrement est vide.", "EMPTY_RECORDING");
                return;
            }

            String base64 = fileToBase64(file);
            JSObject value = new JSObject();
            value.put("recordDataBase64", base64);
            value.put("msDuration", duration);
            value.put("mimeType", "audio/mp4");
            value.put("fileExtension", "m4a");
            value.put("path", file.getAbsolutePath());

            JSObject ret = new JSObject();
            ret.put("value", value);
            call.resolve(ret);
         } catch (Exception error) {
            safeRelease();
            recording = false;
            if (file != null && file.exists() && file.length() < 1024L) file.delete();
            call.reject("Arrêt de l’enregistrement impossible : " + safeMessage(error), "FAILED_TO_FETCH_RECORDING", error);
        }
    }

    @PluginMethod
    public void cancelRecording(PluginCall call) {
        try {
            if (recorder != null) {
                try { recorder.stop(); } catch (Throwable ignored) {}
            }
        } finally {
            safeRelease();
            recording = false;
            if (currentFile != null && currentFile.exists()) currentFile.delete();
            currentFile = null;
            JSObject ret = new JSObject();
            ret.put("value", true);
            call.resolve(ret);
        }
    }

    private String fileToBase64(File file) throws Exception {
        try (FileInputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        }
    }

    private void safeRelease() {
        if (recorder != null) {
            try { recorder.reset(); } catch (Throwable ignored) {}
            try { recorder.release(); } catch (Throwable ignored) {}
            recorder = null;
        }
    }

    private String safeMessage(Throwable error) {
        String msg = error.getMessage();
        return msg == null || msg.trim().isEmpty() ? error.getClass().getSimpleName() : msg;
    }

    @Override
    protected void handleOnDestroy() {
        if (recording && recorder != null) {
            try { recorder.stop(); } catch (Throwable ignored) {}
        }
        safeRelease();
        recording = false;
        super.handleOnDestroy();
    }
}
`;
fs.writeFileSync(pluginFile, pluginSource);

const activitySource = `package mg.assistantpv.carnet;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeAudioRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
fs.writeFileSync(mainActivity, activitySource);

console.log('Enregistreur Android natif intégré :', pluginFile);
console.log('Permission RECORD_AUDIO vérifiée et plugin enregistré dans MainActivity.');
