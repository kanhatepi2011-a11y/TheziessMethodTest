import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseBoxes, getBoxHeaderSize, findHandlerType } from "../src/mp4-boxes.mjs";
import { inflateSampleTableVideo } from "../src/mp4-inflate.mjs";
import { normalizeContainer } from "../src/mp4-normalize.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(testDir, "fixtures");

function loadFixture(name) {
    const bytes = new Uint8Array(readFileSync(join(fixturesDir, name)));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { bytes, view };
}

function findBox(boxes, type) {
    return boxes.find((b) => b.type === type);
}

function ffprobeOk(buffer, basename) {
    const dir = mkdtempSync(join(tmpdir(), "noblur-"));
    const path = join(dir, basename);
    writeFileSync(path, Buffer.from(buffer));
    try {
        execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv", path], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        return true;
    } catch {
        return false;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function videoSampleCount(view, bytes) {
    const top = parseBoxes(bytes, view, 0, bytes.length);
    const moov = findBox(top, "moov");

    for (const trak of parseBoxes(bytes, view, moov.offset + getBoxHeaderSize(moov), moov.end)) {
        if (trak.type !== "trak") continue;
        let isVideo = false;
        let stsz = null;
        const walk = (start, end) => {
            for (const box of parseBoxes(bytes, view, start, end)) {
                if (box.type === "hdlr" && findHandlerType(bytes, box) === "vide") isVideo = true;
                if (box.type === "stsz") stsz = box;
                if (["trak", "mdia", "minf", "stbl"].includes(box.type)) {
                    walk(box.offset + getBoxHeaderSize(box), box.end);
                }
            }
        };
        walk(trak.offset + getBoxHeaderSize(trak), trak.end);
        if (isVideo && stsz) return view.getUint32(stsz.offset + 16, false);
    }
    return null;
}

describe("mp4-boxes: parseBoxes", () => {
    it("finds top-level ftyp, moov, mdat in fast-start mp4", () => {
        const { bytes, view } = loadFixture("h264_faststart.mp4");
        const boxes = parseBoxes(bytes, view, 0, bytes.length);
        const types = boxes.map((b) => b.type);
        expect(types).toContain("ftyp");
        expect(types).toContain("moov");
        expect(types).toContain("mdat");
    });

    it("parses 64-bit sized boxes when size field is 1", () => {
        const { bytes, view } = loadFixture("h264_faststart.mp4");
        const boxes = parseBoxes(bytes, view, 0, bytes.length);
        const moov = findBox(boxes, "moov");
        expect(moov).toBeTruthy();
        const child = parseBoxes(bytes, view, moov.offset + getBoxHeaderSize(moov), moov.end);
        expect(child.length).toBeGreaterThan(0);
        for (const b of child) {
            expect(b.offset + b.size).toBeLessThanOrEqual(moov.end);
        }
    });

    it("handles zero-size box as running-to-end", () => {
        const buf = new ArrayBuffer(24);
        const b = new Uint8Array(buf);
        const v = new DataView(buf);
        v.setUint32(0, 0, false);
        b[4] = 0x6d; b[5] = 0x6f; b[6] = 0x6f; b[7] = 0x76;
        const boxes = parseBoxes(b, v, 0, 24);
        expect(boxes[0].size).toBe(24);
        expect(boxes[0].type).toBe("moov");
    });
});

describe("mp4-inflate: inflateSampleTableVideo", () => {
    const cases = [
        ["h264_faststart.mp4", 10],
        ["h264_mdat_first.mp4", 10],
        ["h264_co64.mp4", 10],
        ["hevc_faststart.mp4", 10],
        ["h264_faststart.mov", 10],
    ];

    for (const [fixture, mult] of cases) {
        it(`inflates ${fixture} ${mult}x and stays playable`, () => {
            const { bytes, view } = loadFixture(fixture);
            const before = videoSampleCount(view, bytes);

            const result = inflateSampleTableVideo(bytes, view, mult);
            const out = new Uint8Array(result.newBuffer);
            const outView = new DataView(result.newBuffer);
            const after = videoSampleCount(outView, out);

            expect(after).toBe(before * mult);

            const top = parseBoxes(out, outView, 0, out.length);
            const moov = findBox(top, "moov");
            const mdat = findBox(top, "mdat");
            expect(moov).toBeTruthy();
            expect(mdat).toBeTruthy();

            expect(ffprobeOk(result.newBuffer, `${fixture}.patched.mp4`)).toBe(true);
        });
    }

    it("uses codec-aware dummy sizes (h264 = 8B, hevc = 16B)", () => {
        const h264 = loadFixture("h264_faststart.mp4");
        const hevc = loadFixture("hevc_faststart.mp4");
        const h264Out = new Uint8Array(inflateSampleTableVideo(h264.bytes, h264.view, 5).newBuffer);
        const hevcOut = new Uint8Array(inflateSampleTableVideo(hevc.bytes, hevc.view, 5).newBuffer);
        expect(h264Out.length - h264.bytes.length).toBeLessThan(
            hevcOut.length - hevc.bytes.length,
        );
    });

    it("throws on missing moov", () => {
        const bytes = new Uint8Array(32);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 32, false);
        bytes[4] = 0x66; bytes[5] = 0x74; bytes[6] = 0x79; bytes[7] = 0x70;
        expect(() => inflateSampleTableVideo(bytes, view, 10)).toThrow(/moov/i);
    });

    it("throws on multiplier below 2", () => {
        const { bytes, view } = loadFixture("h264_faststart.mp4");
        expect(() => inflateSampleTableVideo(bytes, view, 1)).toThrow(/multiplier/i);
    });
});

describe("production pipeline: normalize -> inflate (mdat-first input)", () => {
    it("normalizes then inflates and stays playable with moov before mdat", () => {
        const { bytes, view } = loadFixture("h264_mdat_first.mp4");

        const norm = normalizeContainer(bytes, view);
        const inflated = inflateSampleTableVideo(norm.newBytes, norm.newView, 10);
        const out = new Uint8Array(inflated.newBuffer);
        const outView = new DataView(inflated.newBuffer);

        const top = parseBoxes(out, outView, 0, out.length);
        const moov = findBox(top, "moov");
        const mdat = findBox(top, "mdat");
        expect(moov.offset).toBeLessThan(mdat.offset);
        expect(videoSampleCount(outView, out)).toBe(videoSampleCount(view, bytes) * 10);
        expect(ffprobeOk(inflated.newBuffer, "prod.mp4")).toBe(true);
    });
});

describe("normalizeContainer", () => {
    it("leaves already fast-start mp4 as valid and playable", () => {
        const { bytes, view } = loadFixture("h264_faststart.mp4");
        const result = normalizeContainer(bytes, view);
        const out = new Uint8Array(result.newBuffer);
        const top = parseBoxes(out, new DataView(result.newBuffer), 0, out.length);
        const moov = findBox(top, "moov");
        const mdat = findBox(top, "mdat");
        expect(moov.offset).toBeLessThan(mdat.offset);
        expect(ffprobeOk(result.newBuffer, "norm.mp4")).toBe(true);
    });

    it("reorders mdat-first mp4 so moov precedes mdat", () => {
        const { bytes, view } = loadFixture("h264_mdat_first.mp4");
        const before = parseBoxes(bytes, view, 0, bytes.length);
        const beforeMoov = findBox(before, "moov");
        const beforeMdat = findBox(before, "mdat");
        expect(beforeMdat.offset).toBeLessThan(beforeMoov.offset);

        const result = normalizeContainer(bytes, view);
        const out = new Uint8Array(result.newBuffer);
        const after = parseBoxes(out, new DataView(result.newBuffer), 0, out.length);
        expect(findBox(after, "moov").offset).toBeLessThan(findBox(after, "mdat").offset);
        expect(ffprobeOk(result.newBuffer, "norm-mdat.mp4")).toBe(true);
    });

    it("rewrites ftyp major brand to isom for HEVC", () => {
        const { bytes, view } = loadFixture("hevc_faststart.mp4");
        const result = normalizeContainer(bytes, view);
        const out = new Uint8Array(result.newBuffer);
        const top = parseBoxes(out, new DataView(result.newBuffer), 0, out.length);
        const ftyp = findBox(top, "ftyp");
        const brand = String.fromCharCode(
            out[ftyp.offset + 8],
            out[ftyp.offset + 9],
            out[ftyp.offset + 10],
            out[ftyp.offset + 11],
        );
        expect(brand).toBe("isom");
    });
});
