import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseBoxes, getBoxHeaderSize } from "../src/mp4-boxes.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(dir, "fixtures");

function convertStcoToCo64(inputPath, outputPath) {
    const bytes = new Uint8Array(readFileSync(inputPath));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const top = parseBoxes(bytes, view, 0, bytes.length);
    const moov = top.find((b) => b.type === "moov");
    if (!moov) throw new Error("no moov in " + inputPath);

    let stcoBox = null;
    const ancestors = new Map();
    const walk = (start, end, parent) => {
        for (const box of parseBoxes(bytes, view, start, end)) {
            if (parent) ancestors.set(box, parent);
            if (box.type === "stco") {
                stcoBox = box;
            } else if (["moov", "trak", "mdia", "minf", "stbl"].includes(box.type)) {
                walk(box.offset + getBoxHeaderSize(box), box.end, box);
            }
        }
    };
    walk(moov.offset + getBoxHeaderSize(moov), moov.end, moov);
    if (!stcoBox) throw new Error("no stco in " + inputPath);

    const count = view.getUint32(stcoBox.offset + 12, false);
    const oldStcoSize = stcoBox.size;
    const newSize = 16 + count * 8;
    const delta = newSize - oldStcoSize;
    const out = new Uint8Array(newSize);
    const ov = new DataView(out.buffer, out.byteOffset, out.byteLength);
    ov.setUint32(0, newSize, false);
    out[4] = 0x63; out[5] = 0x6f; out[6] = 0x36; out[7] = 0x34;
    ov.setUint32(8, 0, false);
    ov.setUint32(12, count, false);
    for (let i = 0; i < count; i++) {
        const off = view.getUint32(stcoBox.offset + 16 + i * 4, false);
        ov.setBigUint64(16 + i * 8, BigInt(off) + BigInt(delta), false);
    }

    const result = new Uint8Array(bytes.length + delta);
    let wp = 0;
    let rp = 0;
    result.set(bytes.subarray(rp, stcoBox.offset), wp);
    wp += stcoBox.offset - rp;
    rp = stcoBox.offset;
    result.set(out, wp);
    wp += out.length;
    rp = stcoBox.end;
    result.set(bytes.subarray(rp), wp);

    const rv = new DataView(result.buffer);
    let chain = [];
    let cur = stcoBox;
    while (cur) {
        chain.push(cur);
        cur = ancestors.get(cur);
    }
    for (const box of chain) {
        if (box.is64Bit) rv.setBigUint64(box.offset + 8, BigInt(box.size + delta), false);
        else rv.setUint32(box.offset, box.size + delta, false);
    }

    writeFileSync(outputPath, result);
    return count;
}

const n = convertStcoToCo64(
    join(fixturesDir, "h264_faststart.mp4"),
    join(fixturesDir, "h264_co64.mp4"),
);
console.log("wrote h264_co64.mp4 (chunks=" + n + ")");
