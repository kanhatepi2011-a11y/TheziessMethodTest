import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const STATIC_ASSETS = [
    "ffmpeg-core",
    "ffmpeg-core-mt",
    "ffmpeg-worker",
    "coi-serviceworker.js",
    "preview.webp",
    "logo.png",
];

function copyStaticAssets() {
    const dist = "dist";
    if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
    for (const asset of STATIC_ASSETS) {
        const src = asset;
        const dest = `${dist}/${asset}`;
        if (!existsSync(src)) continue;
        cpSync(src, dest, { recursive: true });
    }
}

export default defineConfig({
    base: "./",
    server: {
        host: true,
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
        },
    },
    preview: {
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
        },
    },
    build: {
        copyPublicDir: false,
        rollupOptions: {
            input: {
                main: resolve(process.cwd(), "index.html"),
                terms: resolve(process.cwd(), "terms.html"),
                privacy: resolve(process.cwd(), "privacy.html"),
            },
            plugins: [
                {
                    name: "copy-static-assets",
                    closeBundle: copyStaticAssets,
                },
            ],
        },
    },
    test: {
        environment: "happy-dom",
    },
});
