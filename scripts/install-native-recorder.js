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
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;

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
import java.util.ArrayList;

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
    private long startedAt = 0L;

    private SpeechRecognizer speechRecognizer;
    private ParcelFileDescriptor speechReadFd;
    private ParcelFileDescriptor speechWriteFd;
    private OutputStream speechPipeOut;
    private volatile String transcript = "";
    private volatile String finalTranscript = "";
    private volatile String transcriptionStatus = "idle";
    private volatile String transcriptionError = "";
    private volatile boolean transcriptionRequested = false;
    private volatile float transcriptionConfidence = -1.0f;

    @PluginMethod
    public void diagnostics(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("permission", String.valueOf(getPermissionState("microphone")));
        ret.put("recording", recording);
        ret.put("sdk", Build.VERSION.SDK_INT);
        ret.put("manufacturer", Build.MANUFACTURER);
        ret.put("model", Build.MODEL);
        ret.put("speechRecognizerAvailable", SpeechRecognizer.isRecognitionAvailable(getContext()));
        ret.put("liveTranscriptionSupported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && SpeechRecognizer.isRecognitionAvailable(getContext()));
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
        cleanupSpeechRecognizer();
        transcript = "";
        finalTranscript = "";
        transcriptionError = "";
        transcriptionStatus = "idle";
        transcriptionRequested = Boolean.TRUE.equals(call.getBoolean("transcribe", true));
        transcriptionConfidence = -1.0f;
        final String language = call.getString("language", "mg-MG");
        final boolean preferOffline = Boolean.TRUE.equals(call.getBoolean("preferOffline", true));
        final String biasingText = call.getString("biasingText", "");

        try {
            File dir = new File(getContext().getFilesDir(), "audios");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("Impossible de créer le dossier audio.", "STORAGE_ERROR");
                return;
            }
            currentFile = new File(dir, "rec-" + System.currentTimeMillis() + ".wav");

            int minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT);
            int bufferSize = Math.max(minBuffer, SAMPLE_RATE * 2);
            audioRecord = new AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                bufferSize
            );
            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                safeReleaseAudioRecord();
                call.reject("Le microphone Android n’a pas pu être initialisé.", "AUDIO_INIT_FAILED");
                return;
            }

            wavOut = new FileOutputStream(currentFile);
            wavOut.write(new byte[44]);
            pcmBytes = 0L;

            if (transcriptionRequested) setupInjectedSpeechRecognition(language, preferOffline, biasingText);
            else transcriptionStatus = "disabled";

            audioRecord.startRecording();
            startedAt = System.currentTimeMillis();
            recording = true;
            captureThread = new Thread(() -> captureLoop(bufferSize), "AssistantPV-AudioCapture");
            captureThread.start();

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

    private void setupInjectedSpeechRecognition(String language, boolean preferOffline, String biasingText) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !SpeechRecognizer.isRecognitionAvailable(getContext())) {
            transcriptionStatus = "unsupported";
            transcriptionError = "Reconnaissance vocale injectée non disponible sur cet Android.";
            return;
        }
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            speechReadFd = pipe[0];
            speechWriteFd = pipe[1];
            speechPipeOut = new ParcelFileDescriptor.AutoCloseOutputStream(speechWriteFd);
            transcriptionStatus = "starting";

            new Handler(Looper.getMainLooper()).post(() -> {
                try {
                    speechRecognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                    speechRecognizer.setRecognitionListener(new RecognitionListener() {
                        @Override public void onReadyForSpeech(Bundle params) { transcriptionStatus = "listening"; }
                        @Override public void onBeginningOfSpeech() { transcriptionStatus = "listening"; }
                        @Override public void onRmsChanged(float rmsdB) {}
                        @Override public void onBufferReceived(byte[] buffer) {}
                        @Override public void onEndOfSpeech() { if (recording) transcriptionStatus = "processing"; }
                        @Override public void onError(int error) {
                            transcriptionStatus = "error";
                            transcriptionError = speechErrorMessage(error);
                        }
                        @Override public void onResults(Bundle results) {
                            updateConfidence(results);
                            String text = bestText(results);
                            if (!text.isEmpty()) {
                                finalTranscript = mergeTranscript(finalTranscript, text);
                                transcript = finalTranscript;
                            }
                            transcriptionStatus = recording ? "listening" : "done";
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
                            transcriptionStatus = "listening";
                        }
                        @Override public void onEndOfSegmentedSession() {
                            transcriptionStatus = "done";
                            if (!finalTranscript.isEmpty()) transcript = finalTranscript;
                        }
                        @Override public void onLanguageDetection(Bundle results) {}
                    });

                    Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                    intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                    intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline);
                    intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
                    intent.putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_LATENCY);
                    if (biasingText != null && !biasingText.trim().isEmpty()) {
                        ArrayList<String> hints = new ArrayList<>();
                        for (String line : biasingText.split("\\\\r?\\\\n")) {
                            String hint = line == null ? "" : line.trim();
                            if (!hint.isEmpty() && hint.length() <= 80) hints.add(hint);
                            if (hints.size() >= 120) break;
                        }
                        if (!hints.isEmpty()) intent.putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, hints);
                    }
                    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, speechReadFd);
                    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
                    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
                    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, SAMPLE_RATE);
                    intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
                    speechRecognizer.startListening(intent);
                } catch (Exception error) {
                    transcriptionStatus = "error";
                    transcriptionError = safeMessage(error);
                    closeSpeechPipe();
                    cleanupSpeechRecognizer();
                }
            });
        } catch (Exception error) {
            transcriptionStatus = "error";
            transcriptionError = safeMessage(error);
            closeSpeechPipe();
        }
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
                    if (speechPipeOut != null) {
                        try {
                            speechPipeOut.write(buffer, 0, read);
                            speechPipeOut.flush();
                        } catch (Exception pipeError) {
                            try { speechPipeOut.close(); } catch (Exception ignored) {}
                            speechPipeOut = null;
                            if (transcriptionStatus.equals("starting") || transcriptionStatus.equals("listening")) {
                                transcriptionStatus = "error";
                                transcriptionError = "Le moteur vocal Android a fermé le flux audio.";
                            }
                        }
                    }
                }
            }
        } catch (Exception error) {
            if (recording) {
                transcriptionError = "Capture audio interrompue : " + safeMessage(error);
            }
        }
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
            try { audioRecord.stop(); } catch (Exception ignored) {}
            if (captureThread != null) {
                try { captureThread.join(1500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            }
            synchronized (this) {
                if (wavOut != null) { try { wavOut.flush(); } catch (Exception ignored) {} try { wavOut.close(); } catch (Exception ignored) {} wavOut = null; }
                if (speechPipeOut != null) { try { speechPipeOut.close(); } catch (Exception ignored) {} speechPipeOut = null; }
            }
            safeReleaseAudioRecord();
            if (file == null || !file.exists() || pcmBytes <= 0L) {
                if (file != null && file.exists()) file.delete();
                call.reject("L’enregistrement est vide.", "EMPTY_RECORDING");
                return;
            }
            writeWavHeader(file, pcmBytes);
            String base64 = fileToBase64(file);
            JSObject value = new JSObject();
            value.put("recordDataBase64", base64);
            value.put("msDuration", duration);
            value.put("mimeType", "audio/wav");
            value.put("fileExtension", "wav");
            value.put("path", file.getAbsolutePath());
            value.put("transcript", transcript);
            JSObject ret = new JSObject();
            ret.put("value", value);
            call.resolve(ret);
            new Handler(Looper.getMainLooper()).postDelayed(this::cleanupSpeechRecognizer, 1800);
        } catch (Exception error) {
            recording = false;
            closeOutputs();
            safeReleaseAudioRecord();
            call.reject("Arrêt de l’enregistrement impossible : " + safeMessage(error), "FAILED_TO_FETCH_RECORDING", error);
        }
    }

    @PluginMethod
    public void cancelRecording(PluginCall call) {
        recording = false;
        try { if (audioRecord != null) audioRecord.stop(); } catch (Exception ignored) {}
        if (captureThread != null) {
            try { captureThread.join(700); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
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
        String stable = matches != null && !matches.isEmpty() && matches.get(0) != null ? matches.get(0).trim() : "";
        String unstable = "";
        try {
            unstable = bundle.getString("android.speech.extra.UNSTABLE_TEXT", "").trim();
        } catch (Exception ignored) {}
        if (unstable.isEmpty()) {
            try {
                ArrayList<String> unstableList = bundle.getStringArrayList("android.speech.extra.UNSTABLE_TEXT");
                if (unstableList != null && !unstableList.isEmpty() && unstableList.get(0) != null) unstable = unstableList.get(0).trim();
            } catch (Exception ignored) {}
        }
        if (!stable.isEmpty() && !unstable.isEmpty() && !stable.endsWith(unstable)) return (stable + " " + unstable).trim();
        return !stable.isEmpty() ? stable : unstable;
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
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        }
    }

    private synchronized void closeOutputs() {
        if (wavOut != null) { try { wavOut.close(); } catch (Exception ignored) {} wavOut = null; }
        if (speechPipeOut != null) { try { speechPipeOut.close(); } catch (Exception ignored) {} speechPipeOut = null; }
        if (speechReadFd != null) { try { speechReadFd.close(); } catch (Exception ignored) {} speechReadFd = null; }
        speechWriteFd = null;
    }

    private void closeSpeechPipe() {
        if (speechPipeOut != null) { try { speechPipeOut.close(); } catch (Exception ignored) {} speechPipeOut = null; }
        if (speechReadFd != null) { try { speechReadFd.close(); } catch (Exception ignored) {} speechReadFd = null; }
        speechWriteFd = null;
    }

    private void safeReleaseAudioRecord() {
        if (audioRecord != null) {
            try { audioRecord.release(); } catch (Exception ignored) {}
            audioRecord = null;
        }
    }

    private void cleanupSpeechRecognizer() {
        SpeechRecognizer recognizer = speechRecognizer;
        speechRecognizer = null;
        if (recognizer != null) {
            new Handler(Looper.getMainLooper()).post(() -> {
                try { recognizer.cancel(); } catch (Exception ignored) {}
                try { recognizer.destroy(); } catch (Exception ignored) {}
            });
        }
        if (!recording) closeSpeechPipe();
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

console.log('Enregistreur Android natif + transcription live intégrés :', pluginFile);
console.log('AudioRecord 16 kHz mono WAV + injection SpeechRecognizer API 33+ + export .pvaud vers Téléchargements/AssistantPV.');
