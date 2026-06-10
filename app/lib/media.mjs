import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { decode as decodeSilk, getDuration as getSilkDuration, isSilk as isSilkAudio } from "silk-wasm";
import { configValue, envOrConfig, configBool, configNumber } from "./config.mjs";
import { dataPath, RUNTIME_DIR, appPath, ensureDir, DATA_DIR } from "./paths.mjs";
import { log } from "./utils.mjs";
import { usableConfigString, spawnCli, commandExists, LOGS_DIR } from "./claude-runner.mjs";
import { loadPrompts } from "./reply.mjs";
import { recentInputs } from "./state.mjs";
import { CDN_BASE_URL } from "./wechat.mjs";
import { resolveProjectPath } from "./paths.mjs";

// ─── CONFIG ───────────────────────────────────────────────────
const RAG_KNOWLEDGE_DIR = resolveProjectPath(configValue("rag.knowledgeDir", "data/knowledge"));
const RAG_SCRIPT = resolveProjectPath(configValue("paths.ragScript", "app/rag.py"));
const DUPLICATE_INPUT_MS = 5000;
const INBOUND_MEDIA_DIR = dataPath("inbound_media");
const WECHAT_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const FILE_TEXT_PREVIEW_CHARS = 6000;
const DEFAULT_VISION_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_VISION_MODEL = "Qwen/Qwen3-VL-32B-Instruct";
export const VISION_MODE = String(envOrConfig("WECHAT_VISION_MODE", "vision.mode", "auto")).trim().toLowerCase();
export const VISION_BASE_URL = usableConfigString(process.env.WECHAT_VISION_BASE_URL ?? process.env.OPENAI_BASE_URL ?? configValue("vision.baseUrl", DEFAULT_VISION_BASE_URL), DEFAULT_VISION_BASE_URL);
export const VISION_API_KEY = usableConfigString(process.env.WECHAT_VISION_API_KEY ?? process.env.OPENAI_API_KEY ?? configValue("vision.apiKey", ""), "");
export const VISION_MODEL = usableConfigString(envOrConfig("WECHAT_VISION_MODEL", "vision.model", DEFAULT_VISION_MODEL), DEFAULT_VISION_MODEL);
export const VISION_DETAIL = envOrConfig("WECHAT_VISION_DETAIL", "vision.detail", "high");
export const VISION_TIMEOUT_MS = configNumber("vision.timeoutMs", 180_000);
export const VOICE_ASR_ENABLED = configBool("voice.enabled", true);
export const VOICE_WHISPERX_PYTHON = usableConfigString(envOrConfig("WECHAT_VOICE_WHISPERX_PYTHON", "voice.whisperxPython", envOrConfig("WECHAT_VOICE_PYTHON", "voice.pythonPath", "python")), "python");
export const VOICE_MODEL = usableConfigString(envOrConfig("WECHAT_VOICE_MODEL", "voice.model", "large-v3"), "large-v3");
export const VOICE_LANGUAGE = String(envOrConfig("WECHAT_VOICE_LANGUAGE", "voice.language", "auto") || "auto").trim();
export const VOICE_COMPUTE_TYPE = usableConfigString(envOrConfig("WECHAT_VOICE_COMPUTE_TYPE", "voice.computeType", "default"), "default");
export const VOICE_BATCH_SIZE = configNumber("voice.batchSize", 8);
export const VOICE_SAMPLE_RATE = configNumber("voice.sampleRate", 24000);
export const VOICE_NO_ALIGN = configBool("voice.noAlign", true);
export const VOICE_TIMEOUT_MS = configNumber("voice.timeoutMs", 180_000);

// ─── helpers ──────────────────────────────────────────────────
function mediaLogPath() {
  return path.join(LOGS_DIR, "inbound-media.jsonl");
}

export function logInboundMedia(msg) {
  if (!msg.item_list?.some(i => i.type !== 1)) return;
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(mediaLogPath(), JSON.stringify({
      timestamp: new Date().toISOString(),
      from_user_id: msg.from_user_id,
      context_token: msg.context_token,
      item_list: msg.item_list,
    }) + "\n");
  } catch {}
}

export function getMimeFromFilename(filename = "") {
  const ext = path.extname(filename).toLowerCase();
  const m = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".zip": "application/zip",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return m[ext] || "application/octet-stream";
}

export function extensionFromMime(mime = "application/octet-stream", fallback = ".bin") {
  const m = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/silk": ".silk",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/zip": ".zip",
  };
  return m[mime.split(";")[0].trim().toLowerCase()] || fallback;
}

export function detectMimeFromBuffer(buf, fallback = "application/octet-stream") {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && ["GIF87a", "GIF89a"].includes(buf.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "application/zip";
  return fallback;
}

export function imageDimensions(buf) {
  try {
    if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && ["GIF87a", "GIF89a"].includes(buf.subarray(0, 6).toString("ascii"))) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 30 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
      const chunk = buf.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X" && buf.length >= 30) {
        return {
          width: 1 + buf.readUIntLE(24, 3),
          height: 1 + buf.readUIntLE(27, 3),
        };
      }
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset++; continue; }
        const marker = buf[offset + 1];
        const len = buf.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
        }
        offset += 2 + len;
      }
    }
  } catch {}
  return null;
}

export function sanitizeFilename(name = "file.bin") {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "file.bin";
}

function parseAesKey(aesKeyBase64, label) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`${label}: invalid aes_key length ${decoded.length}`);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function cdnDownloadUrl(media) {
  if (media?.full_url) return media.full_url;
  if (!media?.encrypt_query_param) return null;
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
}

async function fetchBuffer(url, label, timeoutMs = 60_000) {
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), effectiveTimeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${label}: CDN ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > WECHAT_MEDIA_MAX_BYTES) throw new Error(`${label}: media too large (${buf.length} bytes)`);
    return buf;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${label}: download timeout after ${effectiveTimeout}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function downloadCdnMedia(media, aesKeyBase64, label) {
  const url = cdnDownloadUrl(media);
  if (!url) throw new Error(`${label}: missing CDN download url`);
  const downloaded = await fetchBuffer(url, label);
  if (!aesKeyBase64) return downloaded;
  return decryptAesEcb(downloaded, parseAesKey(aesKeyBase64, label));
}

function saveInboundBuffer(buf, { kind, mime, originalFilename }) {
  if (!fs.existsSync(INBOUND_MEDIA_DIR)) fs.mkdirSync(INBOUND_MEDIA_DIR, { recursive: true });
  const fallbackExt = extensionFromMime(mime);
  const safeOriginal = sanitizeFilename(originalFilename || `${kind}${fallbackExt}`);
  const ext = path.extname(safeOriginal) || fallbackExt;
  const base = path.basename(safeOriginal, path.extname(safeOriginal));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(INBOUND_MEDIA_DIR, `${stamp}-${crypto.randomUUID().slice(0, 8)}-${base}${ext}`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function wavFromPcm16le(pcm, sampleRate) {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function runProcessText(command, args, { cwd = process.cwd(), timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const proc = spawnCli(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill();
      }
    }, timeoutMs);
    proc.stdout.on("data", d => { stdout += d; if (stdout.length > 8000) stdout = stdout.slice(-8000); });
    proc.stderr.on("data", d => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      settled = true;
      resolve({ code, stdout, stderr, timedOut: proc.killed });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      settled = true;
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`.trim(), timedOut: false });
    });
  });
}

async function transcribeVoiceWithWhisperX(filePath) {
  if (!VOICE_ASR_ENABLED) return null;
  if (!filePath || !fs.existsSync(filePath)) return { error: "voice file missing" };
  if (!commandExists(VOICE_WHISPERX_PYTHON)) return { error: `voice WhisperX python not found: ${VOICE_WHISPERX_PYTHON}` };

  const input = fs.readFileSync(filePath);
  const runtimeDir = path.join(RUNTIME_DIR, "voice_asr");
  ensureDir(runtimeDir);
  const stem = `${path.basename(filePath, path.extname(filePath))}-${crypto.randomUUID().slice(0, 8)}`;
  const wavPath = path.join(runtimeDir, `${stem}.wav`);
  const outDir = path.join(runtimeDir, `${stem}-out`);
  ensureDir(outDir);

  let durationMs = null;
  if (isSilkAudio(input)) {
    durationMs = getSilkDuration(input);
    const decoded = await decodeSilk(input, VOICE_SAMPLE_RATE);
    fs.writeFileSync(wavPath, wavFromPcm16le(decoded.data, VOICE_SAMPLE_RATE));
  } else {
    fs.copyFileSync(filePath, wavPath);
  }

  const args = [
    "-m", "whisperx",
    wavPath,
    "--model", VOICE_MODEL,
    "--output_dir", outDir,
    "--output_format", "txt",
    "--batch_size", String(VOICE_BATCH_SIZE),
    "--compute_type", VOICE_COMPUTE_TYPE,
    "--verbose", "False",
  ];
  if (VOICE_LANGUAGE && VOICE_LANGUAGE.toLowerCase() !== "auto") {
    args.push("--language", VOICE_LANGUAGE);
  }
  if (VOICE_NO_ALIGN) args.push("--no_align");

  const result = await runProcessText(VOICE_WHISPERX_PYTHON, args, {
    cwd: appPath(),
    timeoutMs: VOICE_TIMEOUT_MS,
  });
  const txtPath = path.join(outDir, `${path.basename(wavPath, path.extname(wavPath))}.txt`);
  const transcript = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf-8").trim() : "";
  if (result.code !== 0 && !transcript) {
    const detail = (result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
    return { error: `WhisperX exited ${result.code}${result.timedOut ? " (timeout)" : ""}${detail ? `: ${detail}` : ""}`, wavPath, durationMs };
  }
  return {
    transcript,
    wavPath,
    durationMs,
    language: VOICE_LANGUAGE || "auto",
    model: VOICE_MODEL,
    error: transcript ? "" : "WhisperX produced empty transcript",
  };
}

export function runPythonExtractor(filePath, mode) {
  const code = String.raw`
import json, re, sys, zipfile, xml.etree.ElementTree as ET
path, mode = sys.argv[1], sys.argv[2]
def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()
def xml_text(data):
    root = ET.fromstring(data)
    return clean(" ".join(root.itertext()))
try:
    if mode == "pdf":
        try:
            from pypdf import PdfReader
        except Exception:
            from PyPDF2 import PdfReader
        reader = PdfReader(path)
        print("\n".join((p.extract_text() or "") for p in reader.pages[:8]))
    elif mode == "docx":
        with zipfile.ZipFile(path) as z:
            print(xml_text(z.read("word/document.xml")))
    elif mode == "pptx":
        out = []
        with zipfile.ZipFile(path) as z:
            for name in sorted(n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml"))[:20]:
                out.append(xml_text(z.read(name)))
        print("\n".join(out))
    elif mode == "xlsx":
        out = []
        with zipfile.ZipFile(path) as z:
            shared = []
            if "xl/sharedStrings.xml" in z.namelist():
                root = ET.fromstring(z.read("xl/sharedStrings.xml"))
                shared = [clean(" ".join(si.itertext())) for si in root]
            sheets = [n for n in z.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")]
            for name in sorted(sheets)[:8]:
                root = ET.fromstring(z.read(name))
                vals = []
                for c in root.iter():
                    if not c.tag.endswith("c"):
                        continue
                    t = c.attrib.get("t")
                    v = next((child.text for child in c if child.tag.endswith("v")), None)
                    if v is None:
                        continue
                    if t == "s" and v.isdigit() and int(v) < len(shared):
                        vals.append(shared[int(v)])
                    else:
                        vals.append(v)
                if vals:
                    out.append(" | ".join(vals[:200]))
        print("\n".join(out))
except Exception as e:
    print("", end="")
`;
  const r = spawnSync("python", ["-X", "utf8", "-c", code, filePath, mode], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: FILE_TEXT_PREVIEW_CHARS * 4,
  });
  return (r.stdout || "").trim();
}

function extractFileTextPreview(filePath, mime, originalFilename = "") {
  const ext = path.extname(originalFilename || filePath).toLowerCase();
  try {
    if (/^text\//.test(mime) || [".txt", ".md", ".csv", ".json", ".log", ".js", ".ts", ".py", ".html", ".css"].includes(ext)) {
      return fs.readFileSync(filePath, "utf-8").slice(0, FILE_TEXT_PREVIEW_CHARS);
    }
  } catch {}
  const mode =
    ext === ".pdf" ? "pdf" :
    ext === ".docx" ? "docx" :
    ext === ".pptx" ? "pptx" :
    ext === ".xlsx" ? "xlsx" : null;
  return mode ? runPythonExtractor(filePath, mode).slice(0, FILE_TEXT_PREVIEW_CHARS) : "";
}

function extractVideoFrame(videoPath) {
  try {
    const out = videoPath.replace(/\.[^.]+$/, "") + "-frame.jpg";
    const r = spawnSync("ffmpeg", ["-y", "-ss", "00:00:01", "-i", videoPath, "-frames:v", "1", "-q:v", "3", out], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    if (r.status === 0 && fs.existsSync(out)) return out;
  } catch {}
  return null;
}

async function fetchJsonWithTimeout(url, bodyObj, timeoutMs, headers = {}) {
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), effectiveTimeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(bodyObj),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`request timeout after ${effectiveTimeout}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function completionsUrl(baseUrl = "") {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return null;
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base) || /\/compatible-mode\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function extractVisionContent(messageContent) {
  if (typeof messageContent === "string") return messageContent;
  if (Array.isArray(messageContent)) {
    return messageContent
      .map(part => typeof part === "string" ? part : (part.text || part.content || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function hasExternalVisionConfig() {
  return Boolean(VISION_BASE_URL && VISION_API_KEY && VISION_MODEL);
}

export function shouldUseExternalVision() {
  if (VISION_MODE === "off" || VISION_MODE === "none" || VISION_MODE === "native") return false;
  if (VISION_MODE === "external" || VISION_MODE === "cloud") return true;
  return hasExternalVisionConfig();
}

export async function captionImageCloud(filePath, hint = "") {
  if (!filePath || !fs.existsSync(filePath)) return null;
  if (!shouldUseExternalVision()) {
    return null;
  }
  if (!hasExternalVisionConfig()) {
    log("\u{1F441}", "external vision skipped: WECHAT_VISION_BASE_URL/API_KEY/MODEL not configured");
    return null;
  }
  const imageBuffer = fs.readFileSync(filePath);
  const mime = detectMimeFromBuffer(imageBuffer, getMimeFromFilename(filePath));
  const imageBase64 = imageBuffer.toString("base64");
  const vcfg = loadPrompts();
  const basePrompt = vcfg.visionCaptionPrompt;
  const prompt = [
    basePrompt,
    hint ? `用户补充文字（可能不完整或带偏）：${hint.slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');

  try {
    const result = await fetchJsonWithTimeout(completionsUrl(VISION_BASE_URL), {
      model: VISION_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${imageBase64}`, detail: VISION_DETAIL } },
        ],
      }],
      temperature: 0.1,
      max_tokens: 420,
      stream: false,
    }, VISION_TIMEOUT_MS, { Authorization: `Bearer ${VISION_API_KEY}` });
    const caption = extractVisionContent(result.choices?.[0]?.message?.content).trim();
    if (caption) {
      log("\u{1F441}", `external vision caption ok (${caption.length} chars, model=${VISION_MODEL})`);
      return caption;
    }
  } catch (e) {
    log("⚠️", `external vision caption skipped: ${e.message?.slice(0, 120) || e}`);
  }
  return null;
}

function refMessageText(ref) {
  if (!ref) return "";
  const parts = [];
  if (ref.title) parts.push(ref.title);
  if (ref.message_item?.text_item?.text) parts.push(ref.message_item.text_item.text);
  if (ref.message_item && [2, 3, 4, 5].includes(ref.message_item.type)) parts.push(`[引用了${mediaKindLabel(ref.message_item.type)}]`);
  return parts.length ? `[引用: ${parts.join(" | ")}]\n` : "";
}

function mediaKindLabel(type) {
  return type === 2 ? "图片" : type === 3 ? "语音" : type === 4 ? "文件" : type === 5 ? "视频" : "媒体";
}

async function downloadInboundMedia(item, label) {
  if (item.type === 2) {
    const img = item.image_item || {};
    const media = img.media || img.thumb_media;
    if (!media?.encrypt_query_param && !media?.full_url) return { kind: "image", error: "missing image media" };
    const aesKey = img.aeskey ? Buffer.from(img.aeskey, "hex").toString("base64") : media?.aes_key;
    const buf = await downloadCdnMedia(media, aesKey, label);
    const mime = detectMimeFromBuffer(buf, "image/jpeg");
    const filePath = saveInboundBuffer(buf, { kind: "image", mime, originalFilename: `image${extensionFromMime(mime, ".jpg")}` });
    const caption = await captionImageCloud(filePath);
    return { kind: "image", path: filePath, mime, dimensions: imageDimensions(buf), caption };
  }
  if (item.type === 3) {
    const voice = item.voice_item || {};
    if (!voice.media?.encrypt_query_param && !voice.media?.full_url) return { kind: "voice", transcript: voice.text || "", error: "missing voice media" };
    if (!voice.media?.aes_key) return { kind: "voice", transcript: voice.text || "", error: "missing voice aes_key" };
    const buf = await downloadCdnMedia(voice.media, voice.media.aes_key, label);
    const filePath = saveInboundBuffer(buf, { kind: "voice", mime: "audio/silk", originalFilename: "voice.silk" });
    const asr = await transcribeVoiceWithWhisperX(filePath);
    if (asr?.error) log("⚠️", `voice WhisperX failed: ${asr.error}`);
    return {
      kind: "voice",
      path: filePath,
      mime: "audio/silk",
      transcript: voice.text || "",
      whisperxTranscript: asr?.transcript || "",
      whisperxError: asr?.error || "",
      whisperxWavPath: asr?.wavPath || "",
      whisperxLanguage: asr?.language || "",
      whisperxDurationMs: asr?.durationMs || null,
      playtime: voice.playtime,
    };
  }
  if (item.type === 4) {
    const f = item.file_item || {};
    if (!f.media?.encrypt_query_param && !f.media?.full_url) return { kind: "file", name: f.file_name || "file", error: "missing file media" };
    if (!f.media?.aes_key) return { kind: "file", name: f.file_name || "file", error: "missing file aes_key" };
    const name = sanitizeFilename(f.file_name || "file.bin");
    const buf = await downloadCdnMedia(f.media, f.media?.aes_key, label);
    const mime = detectMimeFromBuffer(buf, getMimeFromFilename(name));
    const filePath = saveInboundBuffer(buf, { kind: "file", mime, originalFilename: name });
    return { kind: "file", path: filePath, mime, name, size: buf.length, textPreview: extractFileTextPreview(filePath, mime, name) };
  }
  if (item.type === 5) {
    const video = item.video_item || {};
    if (!video.media?.encrypt_query_param && !video.media?.full_url) {
      if (video.thumb_media?.encrypt_query_param || video.thumb_media?.full_url) {
        const thumb = await downloadCdnMedia(video.thumb_media, video.thumb_media?.aes_key, `${label} video-thumb`);
        const mime = detectMimeFromBuffer(thumb, "image/jpeg");
        const thumbPath = saveInboundBuffer(thumb, { kind: "video-thumb", mime, originalFilename: `video-thumb${extensionFromMime(mime, ".jpg")}` });
        const caption = await captionImageCloud(thumbPath, "这是视频缩略图或首帧。");
        return { kind: "video", error: "missing video media; saved thumbnail only", framePath: thumbPath, frameCaption: caption };
      }
      return { kind: "video", error: "missing video media" };
    }
    if (!video.media?.aes_key) return { kind: "video", error: "missing video aes_key" };
    const buf = await downloadCdnMedia(video.media, video.media.aes_key, label);
    const mime = detectMimeFromBuffer(buf, "video/mp4");
    const filePath = saveInboundBuffer(buf, { kind: "video", mime, originalFilename: `video${extensionFromMime(mime, ".mp4")}` });
    const framePath = extractVideoFrame(filePath);
    const frameCaption = framePath ? await captionImageCloud(framePath, "这是视频首帧截图。") : null;
    return { kind: "video", path: filePath, mime, size: buf.length, framePath, frameCaption, playLength: video.play_length };
  }
  return { kind: "unknown", error: `unsupported media type ${item.type}` };
}

function mediaInfoToPrompt(info) {
  if (info.error && !info.path && !info.framePath) return `[${info.kind || "媒体"}：${info.error}]`;
  if (info.kind === "image") {
    const dims = info.dimensions ? `\n尺寸: ${info.dimensions.width}x${info.dimensions.height}` : "";
    const caption = info.caption
      ? `\n外部视觉模型描述:\n${info.caption}`
      : "\n外部视觉模型描述: 未生成。请说明无法确认图片细节，不要自行读取本地图片文件。";
    return `[图片]\n本地路径: ${info.path}\nMIME: ${info.mime}${dims}${caption}\n回复时不要仅凭用户补充文字脑补图片细节。若已有外部视觉描述，请优先依据它，但仍要保守处理不确定内容；不要自行读取本地图片文件。`;
  }
  if (info.kind === "voice") {
    const wechatTranscript = info.transcript ? `\n微信自带语音转文字: ${info.transcript}` : "";
    const whisperxTranscript = info.whisperxTranscript ? `\nWhisperX 语音转文字: ${info.whisperxTranscript}` : "";
    const whisperxError = !info.whisperxTranscript && info.whisperxError ? `\nWhisperX 语音转文字: 未生成（${info.whisperxError}）` : "";
    const duration = info.whisperxDurationMs ? `\n估计时长: ${Math.round(info.whisperxDurationMs / 100) / 10}s` : "";
    const guidance = info.whisperxTranscript
      ? "\n若微信自带转写与 WhisperX 冲突，优先参考 WhisperX；短语音仍可能有误，回复时不要编造语音里没有的内容。"
      : "\n微信自带转写可能不准确，尤其是日语；若内容明显不通顺，回复时应保守确认。";
    return `[语音]\n本地路径: ${info.path || "未保存"}\nMIME: ${info.mime || "unknown"}${duration}${wechatTranscript}${whisperxTranscript}${whisperxError}${guidance}`;
  }
  if (info.kind === "file") {
    const preview = info.textPreview ? `\n可提取文本预览:\n${info.textPreview}` : "\n未能直接提取文本；需要时可读取本地文件。";
    return `[文件]\n文件名: ${info.name || path.basename(info.path || "file")}\n本地路径: ${info.path}\nMIME: ${info.mime}\n大小: ${info.size ?? "unknown"} bytes${preview}`;
  }
  if (info.kind === "video") {
    const frame = info.framePath ? `\n首帧截图: ${info.framePath}` : "";
    const frameCaption = info.frameCaption
      ? `\n首帧外部视觉模型描述:\n${info.frameCaption}`
      : (info.framePath ? "\n首帧外部视觉模型描述: 未生成。请说明无法确认视频画面细节，不要自行读取首帧截图。" : "");
    const videoPath = info.path ? `\n本地路径: ${info.path}` : "";
    const err = info.error ? `\n备注: ${info.error}` : "";
    return `[视频]${videoPath}\nMIME: ${info.mime || "unknown"}\n大小: ${info.size ?? "unknown"} bytes${frame}${frameCaption}${err}\n请优先依据可见首帧信息回复；不要脑补视频中不可见的内容。`;
  }
  return `[媒体]\n${JSON.stringify(info)}`;
}

async function inboundItemToText(item, index, msg) {
  const ref = refMessageText(item.ref_msg);
  if (item.type === 1) return `${ref}${item.text_item?.text || ""}`;
  if (item.type === 3 && item.voice_item?.text && !item.voice_item?.media) return `${ref}[语音转文字]\n${item.voice_item.text}`;
  if ([2, 3, 4, 5].includes(item.type)) {
    try {
      const media = await downloadInboundMedia(item, `msg${msg.message_id || "unknown"} item${index}`);
      return `${ref}${mediaInfoToPrompt(media)}`;
    } catch (e) {
      log("⚠️", `media item ${item.type} failed: ${e.message}`);
      return `${ref}[${mediaKindLabel(item.type)}：下载或解析失败：${e.message}]`;
    }
  }
  if (item.type === 11) return `${ref}[工具调用开始: ${item.tool_call_start_item?.tool_name || "unknown"}]`;
  if (item.type === 12) return `${ref}[工具调用结果: ${item.tool_call_result_item?.tool_name || "unknown"} ${item.tool_call_result_item?.status || ""}]`;
  return `${ref}[未知消息类型 ${item.type ?? "unknown"}]`;
}

export async function extractInboundPayload(msg) {
  logInboundMedia(msg);
  const parts = [];
  let shouldBatch = false;
  let hasText = false;
  let canAppendToBatch = true;
  for (let i = 0; i < (msg.item_list || []).length; i++) {
    const item = msg.item_list[i];
    if ([2, 3, 4, 5].includes(item?.type)) shouldBatch = true;
    if (item?.type === 1) hasText = true;
    else canAppendToBatch = false;
    const part = await inboundItemToText(item, i, msg);
    if (part?.trim()) parts.push(part.trim());
  }
  return { body: parts.join("\n"), shouldBatch, canAppendToBatch: !shouldBatch && hasText && canAppendToBatch };
}

export function isDuplicateInput(userId, body) {
  const key = `${userId}\n${body}`;
  const now = Date.now();
  const last = recentInputs.get(key) || 0;
  recentInputs.set(key, now);
  for (const [k, t] of recentInputs) {
    if (now - t > DUPLICATE_INPUT_MS * 2) recentInputs.delete(k);
  }
  return now - last < DUPLICATE_INPUT_MS;
}
