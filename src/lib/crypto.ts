/** Generates a random URL-safe opaque token, e.g. for 3rd-party access tokens. */
export function generateOpaqueToken(prefix: string, byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  const body = bufferToBase64Url(bytes);
  return `${prefix}_${body}`;
}

export function generateId(byteLength = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bufferToBase64Url(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(new Uint8Array(digest));
}

function bufferToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bufferToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
