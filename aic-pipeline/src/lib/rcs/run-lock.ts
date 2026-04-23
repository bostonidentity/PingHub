type LockState = Set<string>;

const KEY = "__rcsRunLocks";
const globalRef = globalThis as unknown as Record<string, LockState | undefined>;

function getLocks(): LockState {
  let locks = globalRef[KEY];
  if (!locks) {
    locks = new Set<string>();
    globalRef[KEY] = locks;
  }
  return locks;
}

export function acquireRunLock(envName: string): (() => void) | null {
  const locks = getLocks();
  if (locks.has(envName)) return null;
  locks.add(envName);
  return () => {
    locks.delete(envName);
  };
}

export function __resetRunLocksForTests(): void {
  getLocks().clear();
}
