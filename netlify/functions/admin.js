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
