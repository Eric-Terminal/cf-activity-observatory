import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/worker/crypto";

const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

describe("SMTP 凭据加密", () => {
  it("使用随机 IV 完成 AES-GCM 往返", async () => {
    const first = await encryptSecret("p@ssword", key);
    const second = await encryptSecret("p@ssword", key);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    await expect(decryptSecret(first, key)).resolves.toBe("p@ssword");
  });

  it("密钥错误时拒绝解密", async () => {
    const encrypted = await encryptSecret("secret", key);
    const wrong = "Hh0cGxoZGBcWFRQTEhEQDw4NDAsKCQgHBgUEAwIBAAA=";
    await expect(decryptSecret(encrypted, wrong)).rejects.toThrow("无法解密");
  });
});
