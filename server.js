const express = require("express");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

const app = express();

// ====== 你的設定（用 Render 環境變數控制） ======
const PORT = process.env.PORT || 8080;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || "graduation_photo_wall";
const MAX_FILES_PER_UPLOAD = parseInt(process.env.MAX_FILES_PER_UPLOAD || "5", 10);
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "10", 10);

// 可選：加一個活動 PIN（避免路人亂傳）
// 如果你不想要 PIN，就不要設 PHOTO_WALL_PIN（留空即可）
const PHOTO_WALL_PIN = process.env.PHOTO_WALL_PIN || "";

// ====== Cloudinary 初始化 ======
cloudinary.config({
  cloud_name: CLOUD_NAME,
  api_key: API_KEY,
  api_secret: API_SECRET
});

// ====== 檢查必要環境變數 ======
function ensureEnv(req, res) {
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    res.status(500).send("Cloudinary env missing. Please set CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET.");
    return false;
  }
  return true;
}

// ====== 靜態頁面 ======
app.use(express.static("public"));

// ====== SSE (Server-Sent Events)：照片牆即時更新 ======
const sseClients = new Set();

app.get("/api/stream", (req, res) => {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);

  const client = { res };
  sseClients.add(client);

  req.on("close", () => {
    sseClients.delete(client);
  });
});

function sseBroadcast(eventName, dataObj) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`;
  for (const c of sseClients) {
    try {
      c.res.write(payload);
    } catch {}
  }
}

// ====== 上傳：multer memory storage ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    // 擋影片：只接受 image/*
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("Only images are allowed."));
    }
    cb(null, true);
  }
});

// ====== 小工具：PIN 檢查（可選） ======
function checkPin(req, res) {
  if (!PHOTO_WALL_PIN) return true; // 未設定 PIN 就放行
  const pin = (req.body?.pin || req.query?.pin || req.headers["x-pin"] || "").toString().trim();
  if (pin !== PHOTO_WALL_PIN) {
    res.status(401).json({ ok: false, error: "PIN incorrect" });
    return false;
  }
  return true;
}

// 讓前端用 JSON
app.use(express.json({ limit: "1mb" }));

// ====== API：列出照片（從 Cloudinary 讀，確保活動後保留） ======
app.get("/api/photos", async (req, res) => {
  if (!ensureEnv(req, res)) return;

  try {
    // 讀取 folder 內資源，依時間由新到舊
    const result = await cloudinary.api.resources({
      type: "upload",
      prefix: CLOUDINARY_FOLDER + "/",
      max_results: 200,
      direction: "desc"
    });

    const items = (result.resources || []).map(r => {
      // 用 Cloudinary 轉換：自動格式/品質，投影比較順
      const url = cloudinary.url(r.public_id, {
        secure: true,
        fetch_format: "auto",
        quality: "auto"
      });

      const uploader = (r.context && r.context.custom && r.context.custom.uploader) ? r.context.custom.uploader : "";
      return {
        public_id: r.public_id,
        created_at: r.created_at,
        width: r.width,
        height: r.height,
        uploader,
        url
      };
    });

    res.json({ ok: true, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "list_failed" });
  }
});

// ====== API：上傳照片（多張） ======
// 前端以 multipart/form-data 傳：uploader + (可選 pin) + files[]
app.post("/api/upload", upload.array("files", MAX_FILES_PER_UPLOAD), async (req, res) => {
  if (!ensureEnv(req, res)) return;
  if (!checkPin(req, res)) return;

  try {
    const uploader = (req.body.uploader || "").toString().trim() || "匿名";
    const files = req.files || [];

    if (files.length === 0) {
      return res.status(400).json({ ok: false, error: "no_files" });
    }
    if (files.length > MAX_FILES_PER_UPLOAD) {
      return res.status(400).json({ ok: false, error: "too_many_files" });
    }

    const uploaded = [];

    for (const f of files) {
      // 把 buffer 轉成 data URI 送 Cloudinary（免存本機）
      const b64 = f.buffer.toString("base64");
      const dataUri = `data:${f.mimetype};base64,${b64}`;

      const up = await cloudinary.uploader.upload(dataUri, {
        folder: CLOUDINARY_FOLDER,
        resource_type: "image",
        // 寫入上傳者名字（之後照片牆讀得到）
        context: { uploader },
        // 可選：把檔名記著
        use_filename: true,
        unique_filename: true
      });

      uploaded.push({
        public_id: up.public_id,
        created_at: up.created_at,
        uploader,
        url: cloudinary.url(up.public_id, { secure: true, fetch_format: "auto", quality: "auto" })
      });

      // 即時通知照片牆
      sseBroadcast("new", { item: uploaded[uploaded.length - 1] });
    }

    res.json({ ok: true, uploaded });
  } catch (e) {
    console.error(e);
    const msg = (e && e.message) ? e.message : "upload_failed";
    res.status(500).json({ ok: false, error: msg });
  }
});

// 健康檢查
app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Photo wall server running on :${PORT}`);
});
