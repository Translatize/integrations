import { sha256Hex } from "./sha256.js";

// Encoding: START, 40 bit-chars (10 hex digits x 4 bits, most significant bit first), END.
//   START = U+2060 WORD JOINER       END = U+2064 INVISIBLE PLUS
//   bit 0 = U+200B ZERO WIDTH SPACE  bit 1 = U+200C ZERO WIDTH NON-JOINER
export const MARKER_START = "⁠";
export const MARKER_END = "⁤";
const BIT0 = "​";
const BIT1 = "‌";
const MARKER_RE = /⁠([​‌]{40})⁤/g;

export function markerHash(key: string): string {
    return sha256Hex(key).slice(0, 10);
}

function encodeHash(hash: string): string {
    let bits = "";
    for (const hex of hash) bits += parseInt(hex, 16).toString(2).padStart(4, "0");
    return MARKER_START + bits.replace(/0/g, BIT0).replace(/1/g, BIT1) + MARKER_END;
}

/** Appends the invisible marker for `key` to `value`. */
export function wrapWithMarker(key: string, value: string): string {
    return value + encodeHash(markerHash(key));
}

/** Returns the text without markers and the hashes found, in order. */
export function decodeMarkers(text: string): { text: string; markers: string[] } {
    const markers: string[] = [];
    const clean = text.replace(MARKER_RE, (_m, bits: string) => {
        let hash = "";
        for (let i = 0; i < 40; i += 4) {
            const nibble = bits.slice(i, i + 4).replace(new RegExp(BIT0, "g"), "0").replace(new RegExp(BIT1, "g"), "1");
            hash += parseInt(nibble, 2).toString(16);
        }
        markers.push(hash);
        return "";
    });
    return { text: clean, markers };
}

export function stripMarkers(text: string): string {
    return decodeMarkers(text).text;
}

function markersEnabled(): boolean {
    try {
        if (typeof process !== "undefined" && process.env && process.env.TRANSLATIZE_MARKERS === "1") return true;
    } catch {
        /* no process in this runtime */
    }
    try {
        const loc = (globalThis as { location?: { search?: string } }).location;
        if (loc && typeof loc.search === "string") return /[?&]translatize-markers(=|&|$)/.test(loc.search);
    } catch {
        /* no location */
    }
    return false;
}

/** The i18next key is hashed without its namespace prefix ("common:a.b" -> "a.b"). */
function plainKey(key: string | string[]): string {
    const k = Array.isArray(key) ? key[0] : key;
    const colon = k.indexOf(":");
    const dot = k.indexOf(".");
    return colon > -1 && (dot === -1 || colon < dot) ? k.slice(colon + 1) : k;
}

/**
 * Use with `i18n.use(postProcessor)` and `postProcess: ["translatizeMarkers"]`. Inactive unless markers are switched on.
 * With i18next's `postProcessPassResolved: true` the key that actually resolved is used (fallback keys, custom
 * namespace separators); otherwise the first key, without its namespace prefix.
 */
export const postProcessor = {
    type: "postProcessor" as const,
    name: "translatizeMarkers",
    process(value: string, key: string | string[], options?: { i18nResolved?: { usedKey?: unknown } }): string {
        if (typeof value !== "string" || value === "" || !markersEnabled()) return value;
        const used = options?.i18nResolved?.usedKey;
        return wrapWithMarker(typeof used === "string" && used !== "" ? used : plainKey(key), value);
    },
};
