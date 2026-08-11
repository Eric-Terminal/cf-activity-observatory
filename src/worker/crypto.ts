import { base64ToBytes, bytesToBase64 } from "@/worker/utils";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  version: 1;
}

export async function encryptSecret(plaintext: string, encodedKey: string): Promise<EncryptedSecret> {
  const key = await importKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("cf-activity-observatory:smtp:v1") },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv), version: 1 };
}

export async function decryptSecret(secret: EncryptedSecret, encodedKey: string): Promise<string> {
  if (secret.version !== 1) throw new Error("不支持的凭据加密版本");
  const key = await importKey(encodedKey);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: exactBuffer(base64ToBytes(secret.iv)),
        additionalData: new TextEncoder().encode("cf-activity-observatory:smtp:v1"),
      },
      key,
      exactBuffer(base64ToBytes(secret.ciphertext)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("SMTP 凭据无法解密，请检查 CONFIG_ENCRYPTION_KEY");
  }
}

async function importKey(encodedKey: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(encodedKey.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    throw new Error("CONFIG_ENCRYPTION_KEY 必须是 Base64 编码的 32 字节密钥");
  }
  if (bytes.byteLength !== 32) throw new Error("CONFIG_ENCRYPTION_KEY 必须解码为 32 字节");
  return crypto.subtle.importKey("raw", exactBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
