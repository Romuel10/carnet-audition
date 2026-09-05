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
if (!manifestText.includes('android.permission.RECORD_AUDIO')) {
  manifestText = manifestText.replace(/<manifest([^>]*)>/, '<manifest$1>\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />');
}
// SpeechRecognizer doit être découvrable sur Android 11+.
if (!manifestText.includes('android.speech.RecognitionService')) {
  manifestText = manifestText.replace(/<application\b/, '    <queries>\n        <intent>\n            <action android:name="android.speech.RecognitionService" />\n        </intent>\n    </queries>\n\n    <application');
}
manifestText = manifestText.replace(/\s*<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"\s*\/>\s*/g, '\n');
fs.writeFileSync(manifest, manifestText);

fs.mkdirSync(javaDir, { recursive: true });

const pluginSource = `package mg.assistantpv.carnet;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;

@CapacitorPlugin(
    name = "NativeAudioRecorder",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class NativeAudioRecorderPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16000;
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;

    private AudioRecord audioRecord;
    private Thread captureThread;
    private File currentFile;
    private FileOutputStream wavOut;
    private volatile boolean recording = false;
    private volatile long pcmBytes = 0L;
    private volatile boolean pcmStreamingRequested = false;
    private final ArrayDeque<String> pcmChunkQueue = new ArrayDeque<>();
    private static final int MAX_PCM_QUEUE = 28;
    private long startedAt = 0L;

    private SpeechRecognizer speechRecognizer;
    private volatile String transcript = "";
    private volatile String finalTranscript = "";
    private volatile String transcriptionStatus = "idle";
    private volatile String transcriptionError = "";
    private volatile boolean transcriptionRequested = false;
    private volatile float transcriptionConfidence = -1.0f;
    private String speechLanguage = "mg-MG";
    private boolean speechPreferOffline = false;
    private String speechBiasingText = "";
    private volatile boolean speechRestartPending = false;

    @PluginMethod
    public void diagnostics(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("permission", String.valueOf(getPermissionState("microphone")));
        ret.put("recording", recording);
        ret.put("sdk", Build.VERSION.SDK_INT);
        ret.put("manufacturer", Build.MANUFACTURER);
        ret.put("model", Build.MODEL);
        ret.put("speechRecognizerAvailable", SpeechRecognizer.isRecognitionAvailable(getContext()));
        ret.put("onDeviceRecognizerAvailable", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext()));
        ret.put("liveTranscriptionSupported", SpeechRecognizer.isRecognitionAvailable(getContext()));
        ret.put("pcmStreamingSupported", true);
        ret.put("sampleRate", SAMPLE_RATE);
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
        if (getPermissionState("microphone") == PermissionState.GRANTED) beginRecording(call);
        else call.reject("Autorisation du microphone refusée.", "MISSING_PERMISSION");
    }

    private void beginRecording(PluginCall call) {
        cleanupSpeechRecognizer();
        transcript = "";
        finalTranscript = "";
        transcriptionError = "";
        transcriptionStatus = "idle";
        transcriptionRequested = Boolean.TRUE.equals(call.getBoolean("transcribe", true));
        transcriptionConfidence = -1.0f;
        speechLanguage = call.getString("language", "mg-MG");
        speechPreferOffline = Boolean.TRUE.equals(call.getBoolean("preferOffline", false));
        speechBiasingText = call.getString("biasingText", "");
        pcmStreamingRequested = Boolean.TRUE.equals(call.getBoolean("streamPcm", false));
        synchronized (pcmChunkQueue) { pcmChunkQueue.clear(); }

        try {
            File dir = new File(getContext().getFilesDir(), "audios");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("Impossible de créer le dossier audio.", "STORAGE_ERROR");
                return;
            }
            currentFile = new File(dir, "rec-" + System.currentTimeMillis() + ".wav");

            int minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT);
            int bufferSize = Math.max(minBuffer, SAMPLE_RATE);
            AudioFormat format = new AudioFormat.Builder()
                .setSampleRate(SAMPLE_RATE)
                .setEncoding(AUDIO_FORMAT)
                .setChannelMask(CHANNEL_CONFIG)
                .build();
            AudioRecord.Builder builder = new AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.DEFAULT)
                .setAudioFormat(format)
                .setBufferSizeInBytes(bufferSize);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) builder.setPrivacySensitive(false);
            audioRecord = builder.build();
            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                safeReleaseAudioRecord();
                call.reject("Le microphone Android n’a pas pu être initialisé.", "AUDIO_INIT_FAILED");
                return;
            }

            wavOut = new FileOutputStream(currentFile);
            wavOut.write(new byte[44]);
            pcmBytes = 0L;

            audioRecord.startRecording();
            startedAt = System.currentTimeMillis();
            recording = true;
            captureThread = new Thread(() -> captureLoop(bufferSize), "AssistantPV-AudioCapture");
            captureThread.start();

            if (transcriptionRequested) setupDirectSpeechRecognition();
            else transcriptionStatus = "disabled";

            JSObject ret = new JSObject();
            ret.put("value", true);
            ret.put("path", currentFile.getAbsolutePath());
            ret.put("mimeType", "audio/wav");
            ret.put("transcriptionStatus", transcriptionStatus);
            call.resolve(ret);
        } catch (Exception error) {
            recording = false;
            closeOutputs();
            safeReleaseAudioRecord();
            cleanupSpeechRecognizer();
            if (currentFile != null && currentFile.exists()) currentFile.delete();
            call.reject("Démarrage du microphone impossible : " + safeMessage(error), "FAILED_TO_RECORD", error);
        }
    }

    private void setupDirectSpeechRecognition() {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            transcriptionStatus = "unsupported";
            transcriptionError = "Aucun service de reconnaissance vocale Android n’est disponible.";
            return;
        }
        transcriptionStatus = "starting";
        new Handler(Looper.getMainLooper()).post(() -> startSpeechSession(false));
    }

    private void startSpeechSession(boolean restart) {
        if (!recording || !transcriptionRequested) return;
        try {
            if (speechRecognizer == null) {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                speechRecognizer.setRecognitionListener(new RecognitionListener() {
                    @Override public void onReadyForSpeech(Bundle params) { transcriptionStatus = "listening"; }
                    @Override public void onBeginningOfSpeech() { transcriptionStatus = "listening"; }
                    @Override public void onRmsChanged(float rmsdB) {}
                    @Override public void onBufferReceived(byte[] buffer) {}
                    @Override public void onEndOfSpeech() { if (recording) transcriptionStatus = "processing"; }
                    @Override public void onError(int error) {
                        transcriptionError = speechErrorMessage(error);
                        if (recording && shouldRestartSpeech(error)) {
                            transcriptionStatus = "restarting";
                            scheduleSpeechRestart(220);
                        } else {
                            transcriptionStatus = "error";
                        }
                    }
                    @Override public void onResults(Bundle results) {
                        updateConfidence(results);
                        String text = bestText(results);
                        if (!text.isEmpty()) {
                            finalTranscript = mergeTranscript(finalTranscript, text);
                            transcript = finalTranscript;
                            transcriptionError = "";
                        }
                        if (recording) {
                            transcriptionStatus = "restarting";
                            scheduleSpeechRestart(120);
                        } else transcriptionStatus = "done";
                    }
                    @Override public void onPartialResults(Bundle partialResults) {
                        updateConfidence(partialResults);
                        String text = bestText(partialResults);
                        if (!text.isEmpty()) transcript = mergeForPartial(finalTranscript, text);
                        transcriptionStatus = "listening";
                    }
                    @Override public void onEvent(int eventType, Bundle params) {}
                    @Override public void onSegmentResults(Bundle segmentResults) {
                        updateConfidence(segmentResults);
                        String text = bestText(segmentResults);
                        if (!text.isEmpty()) {
                            finalTranscript = mergeTranscript(finalTranscript, text);
                            transcript = finalTranscript;
                        }
                    }
                    @Override public void onEndOfSegmentedSession() {
                        if (recording) scheduleSpeechRestart(120);
                    }
                    @Override public void onLanguageDetection(Bundle results) {}
                });
            }

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, speechLanguage);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            if (speechPreferOffline) intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_LATENCY);
                if (speechBiasingText != null && !speechBiasingText.trim().isEmpty()) {
                    ArrayList<String> hints = new ArrayList<>();
                    for (String line : speechBiasingText.split("\\r?\\n")) {
                        String hint = line == null ? "" : line.trim();
                        if (!hint.isEmpty() && hint.length() <= 80) hints.add(hint);
                        if (hints.size() >= 120) break;
                    }
                    if (!hints.isEmpty()) intent.putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, hints);
                }
            }
            transcriptionStatus = restart ? "restarting" : "starting";
            speechRecognizer.startListening(intent);
        } catch (Exception error) {
            transcriptionStatus = "error";
            transcriptionError = safeMessage(error);
        }
    }

    private boolean shouldRestartSpeech(int error) {
        return error == SpeechRecognizer.ERROR_NO_MATCH ||
               error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ||
               error == SpeechRecognizer.ERROR_CLIENT ||
               error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED;
    }

    private void scheduleSpeechRestart(long delayMs) {
        if (speechRestartPending || !recording) return;
        speechRestartPending = true;
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            speechRestartPending = false;
            if (recording && transcriptionRequested) startSpeechSession(true);
        }, delayMs);
    }

    private void captureLoop(int bufferSize) {
        byte[] buffer = new byte[bufferSize];
        try {
            while (recording && audioRecord != null) {
                int read = audioRecord.read(buffer, 0, buffer.length);
                if (read <= 0) continue;
                synchronized (this) {
                    if (wavOut != null) {
                        wavOut.write(buffer, 0, read);
                        pcmBytes += read;
                    }
                }
                if (pcmStreamingRequested) {
                    byte[] piece = Arrays.copyOf(buffer, read);
                    String encoded = Base64.encodeToString(piece, Base64.NO_WRAP);
                    synchronized (pcmChunkQueue) {
                        while (pcmChunkQueue.size() >= MAX_PCM_QUEUE) pcmChunkQueue.pollFirst();
                        pcmChunkQueue.addLast(encoded);
                    }
                }
            }
        } catch (Exception error) {
            if (recording) transcriptionError = "Capture audio interrompue : " + safeMessage(error);
        }
    }


    @PluginMethod
    public void drainPcmChunks(PluginCall call) {
        JSArray chunks = new JSArray();
        synchronized (pcmChunkQueue) {
            while (!pcmChunkQueue.isEmpty()) chunks.put(pcmChunkQueue.pollFirst());
        }
        JSObject ret = new JSObject();
        ret.put("chunks", chunks);
        ret.put("sampleRate", SAMPLE_RATE);
        call.resolve(ret);
    }

    @PluginMethod
    public void getTranscriptionState(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("status", transcriptionStatus);
        ret.put("text", transcript);
        ret.put("finalText", finalTranscript);
        ret.put("errorMessage", transcriptionError);
        ret.put("requested", transcriptionRequested);
        ret.put("confidence", transcriptionConfidence);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        if (!recording || audioRecord == null) {
            call.reject("Aucun enregistrement en cours.", "RECORDING_HAS_NOT_STARTED");
            return;
        }
        File file = currentFile;
        long duration = Math.max(0L, System.currentTimeMillis() - startedAt);
        try {
            recording = false;
            pcmStreamingRequested = false;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (speechRecognizer != null) {
                    try { speechRecognizer.stopListening(); } catch (Exception ignored) {}
                }
            });
            try { audioRecord.stop(); } catch (Exception ignored) {}
            if (captureThread != null) {
                try { captureThread.join(700); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            }
            synchronized (this) {
                if (wavOut != null) {
                    try { wavOut.flush(); } catch (Exception ignored) {}
                    try { wavOut.close(); } catch (Exception ignored) {}
                    wavOut = null;
                }
            }
            safeReleaseAudioRecord();
            if (file == null || !file.exists() || pcmBytes <= 0L) {
                if (file != null && file.exists()) file.delete();
                call.reject("L’enregistrement est vide.", "EMPTY_RECORDING");
                return;
            }
            writeWavHeader(file, pcmBytes);
            JSObject value = new JSObject();
            value.put("msDuration", duration);
            value.put("mimeType", "audio/wav");
            value.put("fileExtension", "wav");
            value.put("path", file.getAbsolutePath());
            value.put("transcript", transcript);
            JSObject ret = new JSObject();
            ret.put("value", value);
            call.resolve(ret);
            new Handler(Looper.getMainLooper()).postDelayed(this::cleanupSpeechRecognizer, 900);
        } catch (Exception error) {
            recording = false;
            closeOutputs();
            safeReleaseAudioRecord();
            call.reject("Arrêt de l’enregistrement impossible : " + safeMessage(error), "FAILED_TO_FETCH_RECORDING", error);
        }
    }

    @PluginMethod
    public void readAudioFile(PluginCall call) {
        String path = call.getString("path", "");
        if (path.isEmpty()) {
            call.reject("Chemin audio manquant.", "AUDIO_PATH_REQUIRED");
            return;
        }
        try {
            File file = new File(path);
            if (!file.exists() || !file.isFile()) {
                call.reject("Fichier audio introuvable.", "AUDIO_NOT_FOUND");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("dataBase64", fileToBase64(file));
            ret.put("mimeType", "audio/wav");
            ret.put("sizeBytes", file.length());
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("Lecture audio impossible : " + safeMessage(error), "AUDIO_READ_FAILED", error);
        }
    }

    @PluginMethod
    public void deleteAudioFile(PluginCall call) {
        String path = call.getString("path", "");
        boolean ok = true;
        if (!path.isEmpty()) {
            File file = new File(path);
            ok = !file.exists() || file.delete();
        }
        JSObject ret = new JSObject();
        ret.put("deleted", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelRecording(PluginCall call) {
        recording = false;
        pcmStreamingRequested = false;
        synchronized (pcmChunkQueue) { pcmChunkQueue.clear(); }
        try { if (audioRecord != null) audioRecord.stop(); } catch (Exception ignored) {}
        if (captureThread != null) {
            try { captureThread.join(500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        }
        closeOutputs();
        safeReleaseAudioRecord();
        cleanupSpeechRecognizer();
        if (currentFile != null && currentFile.exists()) currentFile.delete();
        currentFile = null;
        JSObject ret = new JSObject();
        ret.put("value", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void saveAuditionFile(PluginCall call) {
        String fileName = call.getString("fileName", "audition.pvaud");
        String dataBase64 = call.getString("dataBase64", "");
        if (dataBase64.isEmpty()) {
            call.reject("Le fichier d’audition est vide.", "EMPTY_FILE");
            return;
        }
        fileName = sanitizeFileName(fileName);
        try {
            byte[] bytes = Base64.decode(dataBase64, Base64.DEFAULT);
            String location;
            String uriText = "";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AssistantPV");
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new Exception("Création du fichier impossible.");
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) throw new Exception("Ouverture du fichier impossible.");
                    out.write(bytes);
                    out.flush();
                }
                uriText = uri.toString();
                location = "Téléchargements/AssistantPV/" + fileName;
            } else {
                File base = getContext().getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
                if (base == null) base = getContext().getFilesDir();
                File dir = new File(base, "AssistantPV");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("Création du dossier impossible.");
                File outFile = new File(dir, fileName);
                try (FileOutputStream out = new FileOutputStream(outFile)) { out.write(bytes); }
                uriText = Uri.fromFile(outFile).toString();
                location = outFile.getAbsolutePath();
            }
            JSObject ret = new JSObject();
            ret.put("value", true);
            ret.put("fileName", fileName);
            ret.put("location", location);
            ret.put("uri", uriText);
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("Impossible d’enregistrer le fichier .pvaud : " + safeMessage(error), "FILE_SAVE_FAILED", error);
        }
    }

    private String sanitizeFileName(String name) {
        String safe = name.replaceAll("[^a-zA-Z0-9._-]", "-");
        if (!safe.toLowerCase().endsWith(".pvaud")) safe += ".pvaud";
        return safe.length() > 120 ? safe.substring(0, 114) + ".pvaud" : safe;
    }

    private void updateConfidence(Bundle bundle) {
        if (bundle == null) return;
        try {
            float[] scores = bundle.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
            if (scores != null && scores.length > 0) transcriptionConfidence = scores[0];
        } catch (Exception ignored) {}
    }

    private String bestText(Bundle bundle) {
        if (bundle == null) return "";
        ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return matches != null && !matches.isEmpty() && matches.get(0) != null ? matches.get(0).trim() : "";
    }

    private String mergeForPartial(String finalPart, String partial) {
        if (finalPart == null || finalPart.trim().isEmpty()) return partial == null ? "" : partial.trim();
        if (partial == null || partial.trim().isEmpty()) return finalPart.trim();
        String a = finalPart.trim();
        String b = partial.trim();
        if (b.startsWith(a)) return b;
        return (a + " " + b).trim();
    }

    private String mergeTranscript(String previous, String next) {
        String a = previous == null ? "" : previous.trim();
        String b = next == null ? "" : next.trim();
        if (a.isEmpty()) return b;
        if (b.isEmpty()) return a;
        if (a.equals(b) || a.endsWith(b)) return a;
        if (b.startsWith(a)) return b;
        return (a + " " + b).trim();
    }

    private String speechErrorMessage(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO: return "erreur audio du moteur vocal";
            case SpeechRecognizer.ERROR_CLIENT: return "moteur vocal interrompu";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "permission vocale insuffisante";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED: return "langue non prise en charge";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: return "modèle de langue indisponible";
            case SpeechRecognizer.ERROR_NETWORK: return "réseau indisponible";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "délai réseau dépassé";
            case SpeechRecognizer.ERROR_NO_MATCH: return "parole non reconnue";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "moteur vocal occupé";
            case SpeechRecognizer.ERROR_SERVER: return "service vocal indisponible";
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED: return "service vocal déconnecté";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "aucune parole détectée";
            default: return "erreur vocale " + error;
        }
    }

    private void writeWavHeader(File file, long dataLength) throws Exception {
        long totalDataLen = dataLength + 36;
        long byteRate = SAMPLE_RATE * 2L;
        byte[] header = new byte[44];
        header[0]='R'; header[1]='I'; header[2]='F'; header[3]='F';
        writeIntLE(header, 4, totalDataLen);
        header[8]='W'; header[9]='A'; header[10]='V'; header[11]='E';
        header[12]='f'; header[13]='m'; header[14]='t'; header[15]=' ';
        writeIntLE(header, 16, 16);
        writeShortLE(header, 20, 1);
        writeShortLE(header, 22, 1);
        writeIntLE(header, 24, SAMPLE_RATE);
        writeIntLE(header, 28, byteRate);
        writeShortLE(header, 32, 2);
        writeShortLE(header, 34, 16);
        header[36]='d'; header[37]='a'; header[38]='t'; header[39]='a';
        writeIntLE(header, 40, dataLength);
        try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
            raf.seek(0);
            raf.write(header);
        }
    }

    private void writeIntLE(byte[] b, int o, long v) {
        b[o] = (byte)(v & 0xff); b[o+1] = (byte)((v >> 8) & 0xff); b[o+2] = (byte)((v >> 16) & 0xff); b[o+3] = (byte)((v >> 24) & 0xff);
    }

    private void writeShortLE(byte[] b, int o, int v) {
        b[o] = (byte)(v & 0xff); b[o+1] = (byte)((v >> 8) & 0xff);
    }

    private String fileToBase64(File file) throws Exception {
        try (FileInputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        }
    }

    private synchronized void closeOutputs() {
        if (wavOut != null) { try { wavOut.close(); } catch (Exception ignored) {} wavOut = null; }
    }

    private void safeReleaseAudioRecord() {
        if (audioRecord != null) {
            try { audioRecord.release(); } catch (Exception ignored) {}
            audioRecord = null;
        }
    }

    private void cleanupSpeechRecognizer() {
        speechRestartPending = false;
        SpeechRecognizer recognizer = speechRecognizer;
        speechRecognizer = null;
        if (recognizer != null) {
            new Handler(Looper.getMainLooper()).post(() -> {
                try { recognizer.cancel(); } catch (Exception ignored) {}
                try { recognizer.destroy(); } catch (Exception ignored) {}
            });
        }
    }

    private String safeMessage(Throwable error) {
        String msg = error.getMessage();
        return msg == null || msg.trim().isEmpty() ? error.getClass().getSimpleName() : msg;
    }

    @Override
    protected void handleOnDestroy() {
        recording = false;
        try { if (audioRecord != null) audioRecord.stop(); } catch (Exception ignored) {}
        closeOutputs();
        safeReleaseAudioRecord();
        cleanupSpeechRecognizer();
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

console.log('Enregistreur Android natif v3.2 beta.1 intégré :', pluginFile);
console.log('Audio WAV + dictée Android + flux PCM optionnel pour transcription en ligne sécurisée.');
