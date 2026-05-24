export const SECRET_KINDS = ["password", "client-secret", "log-api-key", "log-api-secret"] as const;
export type SecretKind = typeof SECRET_KINDS[number];

export function secretKey(envName: string, kind: SecretKind): string {
  return `aic-studio:env:${envName}:${kind}`;
}

/**
 * Adapter interface — matches vscode.SecretStorage shape.
 * Keeps core/ free of vscode imports.
 */
export interface SecretBacking {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SecretStore {
  get(envName: string, kind: SecretKind): Promise<string | undefined>;
  set(envName: string, kind: SecretKind, value: string): Promise<void>;
  deleteAll(envName: string): Promise<void>;
}

export function makeStorage(backing: SecretBacking): SecretStore {
  return {
    get: (envName, kind) => backing.get(secretKey(envName, kind)),
    set: (envName, kind, value) => backing.store(secretKey(envName, kind), value),
    deleteAll: async (envName) => {
      await Promise.all(SECRET_KINDS.map((k) => backing.delete(secretKey(envName, k))));
    }
  };
}
