// Küçük admin panel için arka uç.
// - Kimlik doğrulama: paylaşılan bir şifre (ADMIN_PASSWORD env var).
// - Veri kaynağı: GitHub Contents API üzerinden bu reponun main dalı.
//   Kullanıcının kendi GitHub token'ı (GITHUB_TOKEN env var) sunucu
//   tarafında kalır, tarayıcıya asla gönderilmez.
//
// GET  -> products.json içeriğini döner.
// POST -> { products: [...], newImages: [{ path, base64 }] } bekler,
//         önce yeni fotoğrafları, sonra products.json'u commit'ler.
//         Netlify bu push'u otomatik yakalayıp siteyi yeniden yayınlar.

const GITHUB_OWNER = "mustafademir27";
const GITHUB_REPO = "mmetgoz-optik-web";
const BRANCH = "main";
const PRODUCTS_PATH = "products.json";
const GITHUB_API = "https://api.github.com";

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(data),
  };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "mmetgoz-optik-admin",
  };
}

// ---------------------------------------------------------------------------
// Girdi doğrulama (whitelist). İstemci tarafındaki kontroller atlatılabilir;
// GitHub token'ı repoya yazabildiği için asıl sınır burası.
// worker.js içindeki kopya ile aynı tutulmalı.
// ---------------------------------------------------------------------------
const CATEGORIES = new Set(["sun", "optik", "cocuk", "lens"]);
// Sadece images/ altına, düz dosya adıyla .jpg: "../", alt klasör, .html, _redirects,
// .github/workflows gibi yollar bu kalıba uymaz.
const IMAGE_PATH_RE = /^images\/[a-z0-9][a-z0-9-]{0,119}\.jpg$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const JPEG_BASE64_PREFIX = "/9j/"; // FF D8 FF (JPEG imzası) base64'te böyle başlar
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES_PER_REQUEST = 5;
const MAX_PRODUCTS = 500;

class ValidationError extends Error {}

function readString(value, label, maxLength, { required = false } = {}) {
  if (value == null) value = "";
  if (typeof value !== "string") throw new ValidationError(`${label} metin olmalı.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`${label} boş olamaz.`);
  if (trimmed.length > maxLength) throw new ValidationError(`${label} en fazla ${maxLength} karakter olabilir.`);
  return trimmed;
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

// Bilinmeyen alanları atarak sadece beklenen şekli döndürür.
function sanitizeProduct(raw, index) {
  const label = `${index + 1}. ürün`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${label} geçersiz.`);
  }

  const name = readString(raw.name, `${label}: ad`, 200, { required: true });
  const brand = readString(raw.brand, `${label}: marka`, 100);
  const meta = readString(raw.meta, `${label}: açıklama`, 300);

  if (!CATEGORIES.has(raw.category)) throw new ValidationError(`${label}: kategori geçersiz.`);

  const price = Number(raw.price);
  if (!Number.isFinite(price) || price < 0 || price > 10_000_000) {
    throw new ValidationError(`${label}: fiyat geçersiz.`);
  }

  if (typeof raw.image !== "string" || !IMAGE_PATH_RE.test(raw.image)) {
    throw new ValidationError(`${label}: fotoğraf yolu geçersiz.`);
  }

  const buyUrl = readString(raw.buyUrl, `${label}: satın alma linki`, 500);
  if (buyUrl && !isHttpUrl(buyUrl)) {
    throw new ValidationError(`${label}: satın alma linki http(s) ile başlamalı.`);
  }

  return { name, brand, meta, category: raw.category, price, image: raw.image, buyUrl };
}

function sanitizeNewImage(raw) {
  if (!raw || typeof raw.path !== "string" || !IMAGE_PATH_RE.test(raw.path)) {
    throw new ValidationError("Fotoğraf yolu geçersiz.");
  }
  if (typeof raw.base64 !== "string" || !BASE64_RE.test(raw.base64)) {
    throw new ValidationError("Fotoğraf verisi geçersiz.");
  }
  if (!raw.base64.startsWith(JPEG_BASE64_PREFIX)) {
    throw new ValidationError("Fotoğraf JPEG formatında olmalı.");
  }
  if (Math.floor((raw.base64.length * 3) / 4) > MAX_IMAGE_BYTES) {
    throw new ValidationError("Fotoğraf çok büyük (en fazla 3 MB).");
  }
  return { path: raw.path, base64: raw.base64 };
}

function parseAdminPayload(payload) {
  const { products, newImages } = payload || {};
  if (!Array.isArray(products)) throw new ValidationError("Ürün listesi eksik veya hatalı.");
  if (products.length > MAX_PRODUCTS) throw new ValidationError(`En fazla ${MAX_PRODUCTS} ürün olabilir.`);

  const images = newImages == null ? [] : newImages;
  if (!Array.isArray(images)) throw new ValidationError("Fotoğraf listesi hatalı.");
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    throw new ValidationError(`Tek seferde en fazla ${MAX_IMAGES_PER_REQUEST} fotoğraf yüklenebilir.`);
  }

  return {
    products: products.map(sanitizeProduct),
    newImages: images.map(sanitizeNewImage),
  };
}

async function readProductsFile(token) {
  const res = await fetch(
    `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PRODUCTS_PATH}?ref=${BRANCH}`,
    { headers: githubHeaders(token) }
  );
  if (!res.ok) {
    throw new Error(`GitHub okuma hatası (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { Allow: "GET, POST, OPTIONS" }, body: "" };
  }

  const suppliedPassword = event.headers["x-admin-password"] || "";
  const expectedPassword = process.env.ADMIN_PASSWORD || "";

  if (!expectedPassword) {
    return jsonResponse(500, { error: "Sunucu yapılandırması eksik: ADMIN_PASSWORD tanımlı değil." });
  }
  if (suppliedPassword !== expectedPassword) {
    return jsonResponse(401, { error: "Şifre hatalı." });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return jsonResponse(500, { error: "Sunucu yapılandırması eksik: GITHUB_TOKEN tanımlı değil." });
  }

  try {
    if (event.httpMethod === "GET") {
      const file = await readProductsFile(token);
      const content = Buffer.from(file.content, "base64").toString("utf-8");
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: content,
      };
    }

    if (event.httpMethod === "POST") {
      let payload;
      try {
        payload = JSON.parse(event.body || "{}");
      } catch {
        return jsonResponse(400, { error: "Geçersiz istek gövdesi." });
      }

      // Hiçbir şey commit'lenmeden önce tüm istek doğrulanır; yarım kalmış yazma olmaz.
      let parsed;
      try {
        parsed = parseAdminPayload(payload);
      } catch (err) {
        if (err instanceof ValidationError) return jsonResponse(400, { error: err.message });
        throw err;
      }
      const { products, newImages } = parsed;

      // 1) Yeni yüklenen fotoğrafları commit'le (her biri yeni/benzersiz bir dosya adı).
      for (const img of newImages) {
        const putRes = await fetch(
          `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${img.path}`,
          {
            method: "PUT",
            headers: { ...githubHeaders(token), "Content-Type": "application/json" },
            body: JSON.stringify({
              message: `Ürün fotoğrafı eklendi: ${img.path}`,
              content: img.base64,
              branch: BRANCH,
            }),
          }
        );
        if (!putRes.ok) {
          const detail = await putRes.text();
          return jsonResponse(502, { error: `Fotoğraf yüklenemedi: ${img.path}`, detail });
        }
      }

      // 2) products.json'u güncelle (güncel sha zorunlu).
      const current = await readProductsFile(token);
      const newContent = Buffer.from(
        JSON.stringify({ products }, null, 2) + "\n",
        "utf-8"
      ).toString("base64");

      const putRes = await fetch(
        `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PRODUCTS_PATH}`,
        {
          method: "PUT",
          headers: { ...githubHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "Ürün listesi güncellendi (admin panelinden)",
            content: newContent,
            sha: current.sha,
            branch: BRANCH,
          }),
        }
      );

      if (!putRes.ok) {
        const detail = await putRes.text();
        return jsonResponse(502, { error: "Kaydedilemedi.", detail });
      }

      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(405, { error: "Desteklenmeyen metod." });
  } catch (err) {
    return jsonResponse(500, { error: "Beklenmeyen bir hata oluştu.", detail: String(err) });
  }
};
