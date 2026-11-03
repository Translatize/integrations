export interface StorageAdapter {
    getItem(key: string): Promise<string | null> | string | null;
    setItem(key: string, value: string): Promise<void> | void;
}

/** Default adapter: lives as long as the page/process. */
export function memoryStorage(): StorageAdapter {
    const map = new Map<string, string>();
    return {
        getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
        setItem: (k, v) => {
            map.set(k, v);
        },
    };
}

/** Browser localStorage. Falls back to memory when it is blocked (private mode, SSR). */
export function localStorageAdapter(prefix = "translatize-ota:"): StorageAdapter {
    const fallback = memoryStorage();
    const ls = (): Storage | null => {
        try {
            return (globalThis as { localStorage?: Storage }).localStorage ?? null;
        } catch {
            return null;
        }
    };
    return {
        getItem(k) {
            try {
                const s = ls();
                if (s) return s.getItem(prefix + k);
            } catch {
                /* blocked */
            }
            return fallback.getItem(k);
        },
        setItem(k, v) {
            try {
                const s = ls();
                if (s) {
                    s.setItem(prefix + k, v);
                    return;
                }
            } catch {
                /* quota or blocked */
            }
            fallback.setItem(k, v);
        },
    };
}

/** Minimal shape of @react-native-async-storage/async-storage. */
export interface AsyncStorageLike {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

export function asyncStorageAdapter(asyncStorage: AsyncStorageLike, prefix = "translatize-ota:"): StorageAdapter {
    return {
        getItem: (k) => asyncStorage.getItem(prefix + k),
        setItem: (k, v) => asyncStorage.setItem(prefix + k, v),
    };
}
