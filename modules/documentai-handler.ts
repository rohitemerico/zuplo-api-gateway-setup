import { ZuploContext, ZuploRequest, environment } from "@zuplo/runtime";

// -------------------------------
// Helper: Convert PEM private key to ArrayBuffer
// -------------------------------
function pemToArrayBuffer(pem: string) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, ""); // remove all spaces/newlines
  const binary = atob(b64);
  const len = binary.length;
  const buffer = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

// -------------------------------
// Helper: Generate Google OAuth token
// -------------------------------
async function getGoogleAccessToken(serviceAccountJson: string) {
  const sa = JSON.parse(serviceAccountJson);

  if (!sa.private_key || !sa.client_email) {
    throw new Error("Invalid service account JSON");
  }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600; // 1 hour expiry

  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    exp,
    iat,
  };

  function base64urlEncode(obj: any) {
    return Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  const unsignedToken = `${base64urlEncode(header)}.${base64urlEncode(claimSet)}`;

  // Sign JWT
  const privateKeyBuffer = pemToArrayBuffer(sa.private_key);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const signatureBase64 = Buffer.from(signature)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const jwt = `${unsignedToken}.${signatureBase64}`;

  // Exchange JWT for access token
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const dataToken = await resp.json();
  if (!dataToken.access_token) throw new Error("Failed to get access token");
  return dataToken.access_token;
}






export default async function (request: ZuploRequest, context: ZuploContext) {
  const projectId = environment.GOOGLE_DOCUMENTAI_PROJECT_ID;
  const processorId = environment.GOOGLE_DOCUMENTAI_PROCESSOR_ID;
  const serviceAccountJson = environment.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!projectId || !processorId || !serviceAccountJson) {
    return Response.json({ error: "Missing environment variables" }, { status: 500 });
  }

  let body: { base64Data?: string; mimeType?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.base64Data) {
    return Response.json({ error: "Missing base64Data" }, { status: 400 });
  }

  // Generate OAuth token
  let token: string;
  try {
    token = await getGoogleAccessToken(serviceAccountJson);
  } catch (err) {
    return Response.json({ error: "Failed to generate access token", details: String(err) }, { status: 500 });
  }

  const documentAiPayload = {
    rawDocument: {
      content: body.base64Data,
      mimeType: body.mimeType ?? "application/pdf",
    },
  };

  const url = `https://us-documentai.googleapis.com/v1/projects/${projectId}/locations/us/processors/${processorId}:process`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(documentAiPayload),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      return Response.json({ error: "Document AI request failed", details: errorBody }, { status: response.status });
    }

    const data = await response.json();
    const doc = data.document ?? {};

    return Response.json({
      text: doc.text ?? null,
      mimeType: doc.mimeType ?? null,
      pages: doc.pages?.length ?? 0,
      entities: doc.entities?.map((e: any) => ({
        type: e.type,
        mentionText: e.mentionText,
        confidence: e.confidence,
      })) ?? [],
      raw: data,
    });
  } catch (err) {
    return Response.json({ error: "Failed to reach Document AI", details: String(err) }, { status: 502 });
  }
}