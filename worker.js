// Cloudflare Worker giriş noktası.
// - "/api/admin" isteklerini bu dosyadaki admin API mantığı karşılar.
// - Diğer tüm istekler statik dosya olarak (ASSETS binding, repo kökü) sunulur.
//
// Admin API — küçük bir yönetim paneli için arka uç:
// - Kimlik doğrulama: paylaşılan bir şifre (ADMIN_PASSWORD ortam değişkeni/secret).
// - Veri kaynağı: GitHub Contents API üzerinden bu reponun main dalı.
//   GitHub token'ı (GITHUB_TOKEN ortam değişkeni/secret) sunucu tarafında kalır,
//   tarayıcıya asla gönderilmez.
// - Workers runtime'da Node'un Buffer'ı yok; base64<->utf8 dönüşümleri
//   Web API'leri (atob/btoa + TextEncoder/TextDecoder) ile yapılıyor.

const GITHUB_OWNER = "mustafademir27";
const GITHUB_REPO = "mmetgoz-optik-web";
const BRANCH = "main";
const PRODUCTS_PATH = "products.json";
const GITHUB_API = "https://api.github.com";

function jsonResponse(statusCode, data) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "mmetgoz-optik-admin",
  };
}

function base64ToUtf8(b64) {
  const clean = b64.replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Girdi doğrulama (whitelist). İstemci tarafındaki kontroller atlatılabilir;
// GitHub token'ı repoya yazabildiği için asıl sınır burası.
// netlify/functions/admin.js içindeki kopya ile aynı tutulmalı.
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

async function handleAdmin(request, env) {
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, POST, OPTIONS" } });
  }

  const suppliedPassword = request.headers.get("x-admin-password") || "";
  const expectedPassword = env.ADMIN_PASSWORD || "";

  if (!expectedPassword) {
    return jsonResponse(500, { error: "Sunucu yapılandırması eksik: ADMIN_PASSWORD tanımlı değil." });
  }
  if (suppliedPassword !== expectedPassword) {
    return jsonResponse(401, { error: "Şifre hatalı." });
  }

  const token = env.GITHUB_TOKEN;
  if (!token) {
    return jsonResponse(500, { error: "Sunucu yapılandırması eksik: GITHUB_TOKEN tanımlı değil." });
  }

  try {
    if (method === "GET") {
      const file = await readProductsFile(token);
      const content = base64ToUtf8(file.content);
      return new Response(content, {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (method === "POST") {
      let payload;
      try {
        payload = await request.json();
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
      const newContent = utf8ToBase64(JSON.stringify({ products }, null, 2) + "\n");

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
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/admin") {
      return handleAdmin(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
