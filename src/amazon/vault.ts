import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { AmazonSellerCredentials, CredentialScope, CredentialVault } from "./types.ts";

interface EncryptedRecord {
  iv: string;
  authTag: string;
  ciphertext: string;
}

function associatedData(connectionId: string, scope: CredentialScope): Buffer {
  return Buffer.from(
    JSON.stringify({
      connectionId,
      environmentId: scope.environmentId,
      organizationId: scope.organizationId,
      provider: scope.provider,
    }),
    "utf8",
  );
}

function recordKey(connectionId: string, scope: CredentialScope): string {
  return `${scope.environmentId}:${scope.organizationId}:${scope.provider}:${connectionId}`;
}

/**
 * Reference vault for the platform runtime. In production the encrypted records
 * should be persisted in a database and the master key must come from KMS.
 */
export class AesGcmCredentialVault implements CredentialVault {
  private readonly records = new Map<string, EncryptedRecord>();
  private readonly key: Buffer;

  public constructor(masterKeyBase64: string) {
    this.key = Buffer.from(masterKeyBase64, "base64");
    if (this.key.length !== 32) {
      throw new Error("AMAZON_CREDENTIAL_MASTER_KEY_BASE64 must decode to exactly 32 bytes.");
    }
  }

  public async put(connectionId: string, scope: CredentialScope, credentials: AmazonSellerCredentials): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(associatedData(connectionId, scope));
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    this.records.set(recordKey(connectionId, scope), {
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  }

  public async get(connectionId: string, scope: CredentialScope): Promise<AmazonSellerCredentials | undefined> {
    const record = this.records.get(recordKey(connectionId, scope));
    if (!record) {
      return undefined;
    }

    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(associatedData(connectionId, scope));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as AmazonSellerCredentials;
  }

  public async delete(connectionId: string, scope: CredentialScope): Promise<void> {
    this.records.delete(recordKey(connectionId, scope));
  }

  /** Exposed only for automated tests that prove no plaintext is stored. */
  public inspectEncryptedRecord(connectionId: string, scope: CredentialScope): Readonly<EncryptedRecord> | undefined {
    return this.records.get(recordKey(connectionId, scope));
  }
}
