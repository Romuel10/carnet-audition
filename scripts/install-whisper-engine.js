const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const androidRoot = path.join(root, 'android');
const manifest = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
const javaDir = path.join(androidRoot, 'app', 'src', 'main', 'java', 'mg', 'assistantpv', 'carnet');
const mainActivity = path.join(javaDir, 'MainActivity.java');
const appGradle = path.join(androidRoot, 'app', 'build.gradle');
const whisperRoot = path.join(root, 'vendor', 'whisper.cpp');
const jniDir = path.join(androidRoot, 'app', 'src', 'main', 'jni', 'whisper');

if (!fs.existsSync(manifest) || !fs.existsSync(appGradle)) {
  console.error('Projet Android introuvable. Lancez d’abord npx cap add android.');
  process.exit(1);
}
if (!fs.existsSync(path.join(whisperRoot, 'CMakeLists.txt'))) {
  console.error('vendor/whisper.cpp introuvable. Le workflow doit cloner whisper.cpp v1.9.1 avant android:add.');
  process.exit(1);
}

let manifestText = fs.readFileSync(manifest, 'utf8');
if (!manifestText.includes('android.permission.INTERNET')) {
  manifestText = manifestText.replace(/<manifest([^>]*)>/, '<manifest$1>\n    <uses-permission android:name="android.permission.INTERNET" />');
}
fs.writeFileSync(manifest, manifestText);

fs.mkdirSync(javaDir, { recursive: true });
fs.mkdirSync(jniDir, { recursive: true });

const whisperNativeJava = `package mg.assistantpv.carnet;

public final class WhisperNative {
    static {
        System.loadLibrary("assistantpv_whisper");
    }

    private WhisperNative() {}

    public static native long initContext(String modelPath);
    public static native void freeContext(long contextPtr);
    public static native int fullTranscribe(long contextPtr, int numThreads, float[] audioData, String language, String initialPrompt);
    public static native int getTextSegmentCount(long contextPtr);
    public static native String getTextSegment(long contextPtr, int index);
    public static native String getSystemInfo();
}
`;
fs.writeFileSync(path.join(javaDir, 'WhisperNative.java'), whisperNativeJava);

const pluginJava = `package mg.assistantpv.carnet;

import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "NativeWhisper")
public class NativeWhisperPlugin extends Plugin {
    private static final String TAG = "AssistantPV-Whisper";
    private static final String BASE_ID = "base-q5_1";
    private static final String SMALL_ID = "small-q5_1";
    private static final String BASE_FILE = "ggml-base-q5_1.bin";
    private static final String SMALL_FILE = "ggml-small-q5_1.bin";
    private static final String BASE_SHA1 = "a3733eda680ef76256db5fc5dd9de8629e62c5e7";
    private static final String SMALL_SHA1 = "6fe57ddcfdd1c6b07cdcc73aaf620810ce5fc771";
    private static final String HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean downloading = false;
    private volatile int downloadProgress = 0;
    private volatile String downloadModelId = "";
    private volatile String downloadError = "";
    private long contextPtr = 0L;
    private String loadedModelPath = "";

    @PluginMethod
    public void diagnostics(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("sdk", Build.VERSION.SDK_INT);
        ret.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "?");
        ret.put("nativeInfo", safeNativeInfo());
        ret.put("baseInstalled", modelFile(BASE_ID).exists());
        ret.put("smallInstalled", modelFile(SMALL_ID).exists());
        ret.put("downloading", downloading);
        ret.put("downloadProgress", downloadProgress);
        ret.put("downloadModelId", downloadModelId);
        ret.put("downloadError", downloadError);
        call.resolve(ret);
    }

    @PluginMethod
    public void modelStatus(PluginCall call) {
        String id = normalizeModel(call.getString("modelId", BASE_ID));
        File f = modelFile(id);
        JSObject ret = new JSObject();
        ret.put("modelId", id);
        ret.put("installed", f.exists() && f.length() > 10_000_000L);
        ret.put("sizeBytes", f.exists() ? f.length() : 0L);
        ret.put("path", f.getAbsolutePath());
        ret.put("downloading", downloading && id.equals(downloadModelId));
        ret.put("progress", downloading && id.equals(downloadModelId) ? downloadProgress : 0);
        ret.put("error", downloadError);
        call.resolve(ret);
    }

    @PluginMethod
    public void downloadModel(PluginCall call) {
        String id = normalizeModel(call.getString("modelId", BASE_ID));
        if (downloading) {
            call.reject("Un téléchargement de modèle est déjà en cours.", "DOWNLOAD_BUSY");
            return;
        }
        downloading = true;
        downloadProgress = 0;
        downloadModelId = id;
        downloadError = "";
        worker.submit(() -> {
            try {
                File dir = modelDir();
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("Impossible de créer le dossier des modèles.");
                String fileName = modelFileName(id);
                File target = new File(dir, fileName);
                File part = new File(dir, fileName + ".part");
                if (part.exists()) part.delete();
                URL url = new URL(HF + fileName + "?download=true");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                conn.setRequestProperty("User-Agent", "AssistantPV-Carnet/3.2");
                conn.connect();
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) throw new Exception("Serveur modèle HTTP " + code);
                long total = conn.getContentLengthLong();
                try (BufferedInputStream in = new BufferedInputStream(conn.getInputStream());
                     BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(part))) {
                    byte[] buffer = new byte[128 * 1024];
                    long done = 0L;
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        done += read;
                        if (total > 0) downloadProgress = (int) Math.min(99L, (done * 100L) / total);
                    }
                    out.flush();
                } finally {
                    conn.disconnect();
                }
                if (part.length() < 20_000_000L) throw new Exception("Fichier modèle incomplet.");
                String expected = id.equals(SMALL_ID) ? SMALL_SHA1 : BASE_SHA1;
                String actual = sha1(part);
                if (!expected.equalsIgnoreCase(actual)) throw new Exception("Empreinte du modèle incorrecte. Téléchargement refusé.");
                if (target.exists()) target.delete();
                if (!part.renameTo(target)) {
                    copyFile(part, target);
                    part.delete();
                }
                downloadProgress = 100;
                JSObject ret = new JSObject();
                ret.put("installed", true);
                ret.put("modelId", id);
                ret.put("sizeBytes", target.length());
                call.resolve(ret);
            } catch (Exception e) {
                downloadError = safeMessage(e);
                call.reject("Téléchargement du modèle impossible : " + downloadError, "MODEL_DOWNLOAD_FAILED", e);
            } finally {
                downloading = false;
            }
        });
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        String id = normalizeModel(call.getString("modelId", BASE_ID));
        worker.submit(() -> {
            try {
                File f = modelFile(id);
                synchronized (this) {
                    if (f.getAbsolutePath().equals(loadedModelPath)) releaseContext();
                }
                boolean ok = !f.exists() || f.delete();
                JSObject ret = new JSObject();
                ret.put("deleted", ok);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Suppression du modèle impossible : " + safeMessage(e), "MODEL_DELETE_FAILED", e);
            }
        });
    }

    @PluginMethod
    public void transcribe(PluginCall call) {
        final String audioPath = call.getString("audioPath", "");
        final String modelId = normalizeModel(call.getString("modelId", BASE_ID));
        final String language = normalizeLanguage(call.getString("language", "mg"));
        final String prompt = call.getString("prompt", "");
        if (audioPath.isEmpty()) {
            call.reject("Chemin audio manquant.", "AUDIO_PATH_REQUIRED");
            return;
        }
        worker.submit(() -> {
            long t0 = System.currentTimeMillis();
            try {
                File model = modelFile(modelId);
                if (!model.exists() || model.length() < 10_000_000L) {
                    call.reject("Le modèle IA local n’est pas installé.", "MODEL_NOT_INSTALLED");
                    return;
                }
                File audio = new File(audioPath);
                if (!audio.exists()) {
                    call.reject("Fichier audio introuvable.", "AUDIO_NOT_FOUND");
                    return;
                }
                float[] pcm = readPcm16Wav(audio);
                if (pcm.length == 0) {
                    call.reject("Audio vide ou format WAV non reconnu.", "AUDIO_INVALID");
                    return;
                }
                ensureContext(model);
                int threads = Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors() - 1));
                int rc = WhisperNative.fullTranscribe(contextPtr, threads, pcm, language, trimPrompt(prompt));
                if (rc != 0) throw new Exception("whisper_full a retourné " + rc);
                int n = WhisperNative.getTextSegmentCount(contextPtr);
                StringBuilder text = new StringBuilder();
                for (int i = 0; i < n; i++) {
                    String seg = WhisperNative.getTextSegment(contextPtr, i);
                    if (seg != null && !seg.trim().isEmpty()) {
                        if (text.length() > 0) text.append(' ');
                        text.append(seg.trim());
                    }
                }
                JSObject ret = new JSObject();
                ret.put("text", text.toString().trim());
                ret.put("modelId", modelId);
                ret.put("language", language);
                ret.put("elapsedMs", System.currentTimeMillis() - t0);
                ret.put("offline", true);
                call.resolve(ret);
            } catch (OutOfMemoryError oom) {
                synchronized (this) { releaseContext(); }
                call.reject("Mémoire insuffisante pour ce modèle. Utilisez Base Q5.", "OUT_OF_MEMORY", new Exception(oom));
            } catch (Exception e) {
                Log.e(TAG, "Transcription Whisper échouée", e);
                call.reject("Révision Whisper impossible : " + safeMessage(e), "WHISPER_FAILED", e);
            }
        });
    }

    private synchronized void ensureContext(File model) throws Exception {
        String p = model.getAbsolutePath();
        if (contextPtr != 0L && p.equals(loadedModelPath)) return;
        releaseContext();
        contextPtr = WhisperNative.initContext(p);
        if (contextPtr == 0L) throw new Exception("Le modèle n’a pas pu être chargé.");
        loadedModelPath = p;
    }

    private synchronized void releaseContext() {
        if (contextPtr != 0L) {
            try { WhisperNative.freeContext(contextPtr); } catch (Throwable ignored) {}
            contextPtr = 0L;
            loadedModelPath = "";
        }
    }

    private File modelDir() {
        return new File(getContext().getFilesDir(), "models");
    }

    private File modelFile(String id) {
        return new File(modelDir(), modelFileName(id));
    }

    private String modelFileName(String id) {
        return id.equals(SMALL_ID) ? SMALL_FILE : BASE_FILE;
    }

    private String normalizeModel(String id) {
        return SMALL_ID.equals(id) ? SMALL_ID : BASE_ID;
    }

    private String normalizeLanguage(String lang) {
        String v = lang == null ? "mg" : lang.toLowerCase(Locale.ROOT);
        return v.startsWith("fr") ? "fr" : "mg";
    }

    private String trimPrompt(String s) {
        if (s == null) return "";
        s = s.trim();
        return s.length() > 1200 ? s.substring(0, 1200) : s;
    }

    private float[] readPcm16Wav(File f) throws Exception {
        long length = f.length();
        if (length <= 44) return new float[0];
        long dataOffset = 44;
        long dataSize = length - dataOffset;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            byte[] riff = new byte[4];
            raf.readFully(riff);
            if (riff[0] != 'R' || riff[1] != 'I' || riff[2] != 'F' || riff[3] != 'F') return new float[0];
            raf.seek(dataOffset);
            long maxBytes = Math.min(dataSize, 16000L * 2L * 60L * 15L); // 15 min max par bloc
            int samples = (int) (maxBytes / 2L);
            float[] out = new float[samples];
            byte[] buf = new byte[64 * 1024];
            int idx = 0;
            while (idx < samples) {
                int need = Math.min(buf.length, (samples - idx) * 2);
                int read = raf.read(buf, 0, need);
                if (read <= 0) break;
                int even = read - (read % 2);
                for (int i = 0; i < even && idx < samples; i += 2) {
                    int lo = buf[i] & 0xff;
                    int hi = buf[i + 1];
                    short s = (short) ((hi << 8) | lo);
                    out[idx++] = s / 32768.0f;
                }
            }
            if (idx == out.length) return out;
            float[] trimmed = new float[idx];
            System.arraycopy(out, 0, trimmed, 0, idx);
            return trimmed;
        }
    }

    private String sha1(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-1");
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[128 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return sb.toString();
    }

    private void copyFile(File from, File to) throws Exception {
        try (FileInputStream in = new FileInputStream(from); FileOutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[128 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        }
    }

    private String safeNativeInfo() {
        try { return WhisperNative.getSystemInfo(); } catch (Throwable e) { return "indisponible: " + safeMessage(e); }
    }

    private String safeMessage(Throwable e) {
        String m = e.getMessage();
        return m == null || m.trim().isEmpty() ? e.getClass().getSimpleName() : m;
    }

    @Override
    protected void handleOnDestroy() {
        worker.shutdownNow();
        releaseContext();
        super.handleOnDestroy();
    }
}
`;
fs.writeFileSync(path.join(javaDir, 'NativeWhisperPlugin.java'), pluginJava);

const jniC = `#include <jni.h>
#include <android/log.h>
#include <string.h>
#include "whisper.h"

#define TAG "AssistantPVWhisperJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

JNIEXPORT jlong JNICALL
Java_mg_assistantpv_carnet_WhisperNative_initContext(JNIEnv *env, jclass clazz, jstring model_path_str) {
    (void) clazz;
    const char *path = (*env)->GetStringUTFChars(env, model_path_str, NULL);
    struct whisper_context *ctx = whisper_init_from_file(path);
    (*env)->ReleaseStringUTFChars(env, model_path_str, path);
    return (jlong) ctx;
}

JNIEXPORT void JNICALL
Java_mg_assistantpv_carnet_WhisperNative_freeContext(JNIEnv *env, jclass clazz, jlong context_ptr) {
    (void) env; (void) clazz;
    if (context_ptr) whisper_free((struct whisper_context *) context_ptr);
}

JNIEXPORT jint JNICALL
Java_mg_assistantpv_carnet_WhisperNative_fullTranscribe(JNIEnv *env, jclass clazz, jlong context_ptr, jint num_threads, jfloatArray audio_data, jstring language_str, jstring prompt_str) {
    (void) clazz;
    if (!context_ptr) return -1;
    struct whisper_context *ctx = (struct whisper_context *) context_ptr;
    jfloat *samples = (*env)->GetFloatArrayElements(env, audio_data, NULL);
    const jsize n_samples = (*env)->GetArrayLength(env, audio_data);
    const char *language = (*env)->GetStringUTFChars(env, language_str, NULL);
    const char *prompt = (*env)->GetStringUTFChars(env, prompt_str, NULL);

    struct whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.print_realtime = false;
    params.print_progress = false;
    params.print_timestamps = false;
    params.print_special = false;
    params.translate = false;
    params.language = language;
    params.n_threads = num_threads;
    params.offset_ms = 0;
    params.no_context = true;
    params.single_segment = false;
    if (prompt && strlen(prompt) > 0) params.initial_prompt = prompt;

    whisper_reset_timings(ctx);
    int rc = whisper_full(ctx, params, samples, n_samples);
    if (rc != 0) LOGI("whisper_full failed: %d", rc);

    (*env)->ReleaseFloatArrayElements(env, audio_data, samples, JNI_ABORT);
    (*env)->ReleaseStringUTFChars(env, language_str, language);
    (*env)->ReleaseStringUTFChars(env, prompt_str, prompt);
    return rc;
}

JNIEXPORT jint JNICALL
Java_mg_assistantpv_carnet_WhisperNative_getTextSegmentCount(JNIEnv *env, jclass clazz, jlong context_ptr) {
    (void) env; (void) clazz;
    if (!context_ptr) return 0;
    return whisper_full_n_segments((struct whisper_context *) context_ptr);
}

JNIEXPORT jstring JNICALL
Java_mg_assistantpv_carnet_WhisperNative_getTextSegment(JNIEnv *env, jclass clazz, jlong context_ptr, jint index) {
    (void) clazz;
    if (!context_ptr) return (*env)->NewStringUTF(env, "");
    const char *text = whisper_full_get_segment_text((struct whisper_context *) context_ptr, index);
    return (*env)->NewStringUTF(env, text ? text : "");
}

JNIEXPORT jstring JNICALL
Java_mg_assistantpv_carnet_WhisperNative_getSystemInfo(JNIEnv *env, jclass clazz) {
    (void) clazz;
    const char *info = whisper_print_system_info();
    return (*env)->NewStringUTF(env, info ? info : "");
}
`;
fs.writeFileSync(path.join(jniDir, 'jni.c'), jniC);

const cmake = `cmake_minimum_required(VERSION 3.22.1)
project(assistantpv_whisper)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(WHISPER_LIB_DIR "\${CMAKE_SOURCE_DIR}/../../../../../../vendor/whisper.cpp")

# Le workflow clone explicitement whisper.cpp v1.9.1.
# src/whisper.cpp utilise la macro WHISPER_VERSION ; elle doit donc être
# définie ici quand la source est compilée dans notre bibliothèque JNI.
set(WHISPER_VERSION "1.9.1")

set(SOURCE_FILES
    "\${WHISPER_LIB_DIR}/src/whisper.cpp"
    "\${CMAKE_SOURCE_DIR}/jni.c"
)

find_library(LOG_LIB log)
include(FetchContent)
FetchContent_Declare(ggml SOURCE_DIR "\${WHISPER_LIB_DIR}/ggml")
FetchContent_MakeAvailable(ggml)

add_library(assistantpv_whisper SHARED ${'${SOURCE_FILES}'})
target_link_libraries(assistantpv_whisper PRIVATE ${'${LOG_LIB}'} android ggml)
target_compile_definitions(assistantpv_whisper PUBLIC GGML_USE_CPU)
target_compile_definitions(assistantpv_whisper PRIVATE WHISPER_VERSION=\\"1.9.1\\")
target_compile_options(assistantpv_whisper PRIVATE
    -O3
    -fvisibility=hidden
    -fvisibility-inlines-hidden
    -ffunction-sections
    -fdata-sections
)

target_include_directories(assistantpv_whisper PRIVATE
    "\${WHISPER_LIB_DIR}"
    "\${WHISPER_LIB_DIR}/src"
    "\${WHISPER_LIB_DIR}/include"
    "\${WHISPER_LIB_DIR}/ggml/include"
    "\${WHISPER_LIB_DIR}/ggml/src"
    "\${WHISPER_LIB_DIR}/ggml/src/ggml-cpu"
)
`;
fs.writeFileSync(path.join(jniDir, 'CMakeLists.txt'), cmake);

let gradle = fs.readFileSync(appGradle, 'utf8');
if (!gradle.includes('ndkVersion "25.2.9519653"')) {
  gradle = gradle.replace(/android\s*\{/, 'android {\n    ndkVersion "25.2.9519653"');
}
if (!gradle.includes('abiFilters "arm64-v8a"')) {
  gradle = gradle.replace(/defaultConfig\s*\{/, 'defaultConfig {\n        ndk { abiFilters "arm64-v8a" }\n        externalNativeBuild { cmake { arguments "-DCMAKE_BUILD_TYPE=Release"; cppFlags "-O3" } }');
}
if (!gradle.includes('src/main/jni/whisper/CMakeLists.txt')) {
  const insert = `\n    externalNativeBuild {\n        cmake {\n            path file("src/main/jni/whisper/CMakeLists.txt")\n            version "3.22.1"\n        }\n    }\n`;
  const androidStart = gradle.indexOf('android');
  const openBrace = gradle.indexOf('{', androidStart);
  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < gradle.length; i++) {
    if (gradle[i] === '{') depth++;
    else if (gradle[i] === '}') {
      depth--;
      if (depth === 0) { closeBrace = i; break; }
    }
  }
  if (closeBrace < 0) throw new Error('Bloc android{} introuvable dans app/build.gradle');
  gradle = gradle.slice(0, closeBrace) + insert + gradle.slice(closeBrace);
}
fs.writeFileSync(appGradle, gradle);

if (fs.existsSync(mainActivity)) {
  let activity = fs.readFileSync(mainActivity, 'utf8');
  if (!activity.includes('registerPlugin(NativeWhisperPlugin.class)')) {
    activity = activity.replace('registerPlugin(NativeAudioRecorderPlugin.class);', 'registerPlugin(NativeAudioRecorderPlugin.class);\n        registerPlugin(NativeWhisperPlugin.class);');
  }
  fs.writeFileSync(mainActivity, activity);
}

console.log('Moteur Whisper local installé : whisper.cpp v1.9.1, arm64-v8a, modèles Base/Small Q5 téléchargés à la demande.');
