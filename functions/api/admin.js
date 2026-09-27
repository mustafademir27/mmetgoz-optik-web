// Küçük admin panel için arka uç — Cloudflare Pages Functions sürümü.
// - Kimlik doğrulama: paylaşılan bir şifre (ADMIN_PASSWORD env var).
// - Veri kaynağı: GitHub Contents API üzerinden bu reponun main dalı.
//   Kullanıcının kendi GitHub token'ı (GITHUB_TOKEN env var) sunucu
//   tarafında kalır, tarayıcıya asla gönderilmez.
//
// GET  -> products.json içeriğini döner.
// POST -> { products: [...], newImages: [{ path, base64 }] } bekler,
//         önce yeni fotoğrafları, sonra products.json'u commit'ler.
//         Cloudflare Pages bu push'u yakalayıp siteyi yeniden yayınlar.
//
// Not: Cloudflare Workers ortamında Node'un Buffer'ı yok; base64<->utf8
// dönüşümleri Web API'leri (atob/btoa + TextEncoder/TextDecoder) ile yapılıyor.

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

// GitHub'ın döndürdüğü base64 (satır sonlarıyla) -> UTF-8 metin.
function base64ToUtf8(b64) {
  const clean = b64.replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

// UTF-8 metin -> base64 (GitHub'a commit için).
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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

export async function onRequest(context) {
  const { request, env } = context;
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

      const { products, newImages } = payload;
      if (!Array.isArray(products)) {
        return jsonResponse(400, { error: "Ürün listesi eksik veya hatalı." });
      }

      // 1) Yeni yüklenen fotoğrafları commit'le (her biri yeni/benzersiz bir dosya adı).
      if (Array.isArray(newImages)) {
        for (const img of newImages) {
          if (!img || !img.path || !img.base64) continue;
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
