export function parseBoxes(bytes, view, startOffset, endOffset) {
    const boxes = [];
    let offset = startOffset;
    while (offset + 8 <= endOffset) {
        const rawSize = view.getUint32(offset, false);
        let size;
        let is64Bit = false;

        if (rawSize === 0) {
            size = endOffset - offset;
        } else if (rawSize === 1) {
            is64Bit = true;
            if (offset + 16 > endOffset) break;
            const hi = view.getUint32(offset + 8, false);
            const lo = view.getUint32(offset + 12, false);
            const sizeBig = (BigInt(hi) << 32n) + BigInt(lo);
            if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) break;
            size = Number(sizeBig);
        } else {
            size = rawSize;
        }

        if (size < 8 || offset + size > endOffset) break;

        const type = String.fromCharCode(
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        );
        boxes.push({ offset, size, type, end: offset + size, is64Bit });
        offset += size;
    }
    return boxes;
}

export function getBoxHeaderSize(box) {
    return box.is64Bit ? 16 : 8;
}

const HANDLER_VIDEO = [0x76, 0x69, 0x64, 0x65];

function bytesEqualAt(bytes, offset, pattern) {
    for (let i = 0; i < pattern.length; i++) {
        if (bytes[offset + i] !== pattern[i]) return false;
    }
    return true;
}

export function findHandlerType(bytes, hdlrBox) {
    const start = hdlrBox.offset + getBoxHeaderSize(hdlrBox);
    const end = hdlrBox.end;
    for (let i = start; i + 4 <= end; i++) {
        if (bytesEqualAt(bytes, i, HANDLER_VIDEO)) return "vide";
    }
    return null;
}

export function detectCodecFromStbl(bytes, stblBox) {
    const children = parseBoxes(
        bytes,
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        stblBox.offset + getBoxHeaderSize(stblBox),
        stblBox.end,
    );
    const stsdBox = children.find((b) => b.type === "stsd");
    if (!stsdBox) return "unknown";
    const contentStart = stsdBox.offset + getBoxHeaderSize(stsdBox);
    if (contentStart + 16 > stsdBox.end) return "unknown";
    return String.fromCharCode(
        bytes[contentStart + 12],
        bytes[contentStart + 13],
        bytes[contentStart + 14],
        bytes[contentStart + 15],
    );
}

export function detectVideoCodecFromMoov(bytes, view, moovBox) {
    const moovChildren = parseBoxes(
        bytes,
        view,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );

    for (const trak of moovChildren.filter((b) => b.type === "trak")) {
        const trakChildren = parseBoxes(
            bytes,
            view,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const mdiaBox = trakChildren.find((b) => b.type === "mdia");
        if (!mdiaBox) continue;

        const mdiaChildren = parseBoxes(
            bytes,
            view,
            mdiaBox.offset + getBoxHeaderSize(mdiaBox),
            mdiaBox.end,
        );
        const minfBox = mdiaChildren.find((b) => b.type === "minf");
        if (!minfBox) continue;

        const minfChildren = parseBoxes(
            bytes,
            view,
            minfBox.offset + getBoxHeaderSize(minfBox),
            minfBox.end,
        );
        const stblBox = minfChildren.find((b) => b.type === "stbl");
        if (!stblBox) continue;

        return detectCodecFromStbl(bytes, stblBox);
    }

    return "unknown";
}

export function updateBoxSize(view, offset, box, addedBytes) {
    if (box.is64Bit) {
        view.setBigUint64(offset + 8, BigInt(box.size + addedBytes), false);
    } else {
        view.setUint32(offset, box.size + addedBytes, false);
    }
}

export function updateChunkOffsets(newBytes, newView, boxStart, boxEnd, delta) {
    const containerTypes = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
    for (const box of parseBoxes(newBytes, newView, boxStart, boxEnd)) {
        if (box.type === "stco") {
            const headerSize = getBoxHeaderSize(box);
            const count = newView.getUint32(box.offset + headerSize + 4, false);
            for (let i = 0; i < count; i++) {
                const pos = box.offset + headerSize + 8 + i * 4;
                newView.setUint32(
                    pos,
                    newView.getUint32(pos, false) + delta,
                    false,
                );
            }
        } else if (box.type === "co64") {
            const headerSize = getBoxHeaderSize(box);
            const count = newView.getUint32(box.offset + headerSize + 4, false);
            for (let i = 0; i < count; i++) {
                const pos = box.offset + headerSize + 8 + i * 8;
                newView.setBigUint64(
                    pos,
                    newView.getBigUint64(pos, false) + BigInt(delta),
                    false,
                );
            }
        } else if (containerTypes.has(box.type)) {
            updateChunkOffsets(
                newBytes,
                newView,
                box.offset + getBoxHeaderSize(box),
                box.end,
                delta,
            );
        }
    }
}
