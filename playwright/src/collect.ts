import type { RawRegion } from "./regions.js";

// Runs inside the page via page.evaluate: it is serialised, so it must not use anything from the module scope.
export function collectInPage(opts: { fullPage: boolean }): { regions: RawRegion[]; scrollX: number; scrollY: number } {
    const regions: RawRegion[] = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"]);

    function visible(el: Element): boolean {
        if (el.closest('[aria-hidden="true"]')) return false;
        for (let e: Element | null = el; e; e = e.parentElement) {
            const cs = getComputedStyle(e);
            if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
            if (cs.opacity === "0") return false;
        }
        return true;
    }
    function onScreen(r: DOMRect): boolean {
        if (r.width <= 0 || r.height <= 0) return false;
        if (opts.fullPage) return true;
        return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
    }
    function push(text: string, r: DOMRect, attr?: "placeholder" | "title" | "aria-label" | "alt") {
        const item: RawRegion = { text, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
        if (attr) item.attr = attr;
        regions.push(item);
    }

    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue ?? "";
        const parent = n.parentElement;
        if (!parent || SKIP.has(parent.tagName) || !text.trim()) continue;
        if (!visible(parent)) continue;
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (onScreen(r)) push(text, r);
    }

    const attrs = ["placeholder", "title", "aria-label", "alt"] as const;
    for (const el of Array.from(document.querySelectorAll("[placeholder],[title],[aria-label],[alt]"))) {
        if (SKIP.has(el.tagName) || !visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (!onScreen(r)) continue;
        for (const a of attrs) {
            const v = el.getAttribute(a);
            if (v && v.trim()) push(v, r, a);
        }
    }
    return { regions, scrollX: window.scrollX, scrollY: window.scrollY };
}
