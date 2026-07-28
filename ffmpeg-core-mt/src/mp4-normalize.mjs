import {
    detectVideoCodecFromMoov,
    getBoxHeaderSize,
    parseBoxes,
    updateChunkOffsets,
} from "./mp4-boxes.mjs";

function buildFtyp(isHevc) {
    if (isHevc) {
        const ftyp = new Uint8Array(32);
        const v = new DataView(ftyp.buffer);
        v.setUint32(0, 32, false);
        ftyp.set([0x66, 0x74, 0x79, 0x70], 4);
        ftyp.set([0x69, 0x73, 0x6f, 0x34], 8);
        v.setUint32(12, 0x00000200, false);
        ftyp.set([0x69, 0x73, 0x6f, 0x6d], 16);
        ftyp.set([0x69, 0x73, 0x6f, 0x32], 20);
        ftyp.set([0x68, 0x76, 0x63, 0x31], 24);
        ftyp.set([0x6d, 0x70, 0x34, 0x31], 28);
        return ftyp;
    }
    const ftyp = new Uint8Array(28);
    const v = new DataView(ftyp.buffer);
    v.setUint32(0, 28, false);
    ftyp.set([0x66, 0x74, 0x79, 0x70], 4);
    ftyp.set([0x69, 0x73, 0x6f, 0x6d], 8);
    ftyp.set([0x00, 0x00, 0x02, 0x00], 12);
    ftyp.set([0x69, 0x73, 0x6f, 0x6d], 16);
    ftyp.set([0x69, 0x73, 0x6f, 0x32], 20);
    ftyp.set([0x6d, 0x70, 0x34, 0x31], 24);
    return ftyp;
}

export function normalizeContainer(inputBytes, inputView) {
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);

    const ftypBox = topBoxes.find((b) => b.type === "ftyp");
    const moovBox = topBoxes.find((b) => b.type === "moov");
    const mdatBox = topBoxes.find((b) => b.type === "mdat");

    if (!moovBox) {
        return {
            newBuffer: inputBytes.buffer,
            newBytes: inputBytes,
            newView: inputView,
            changed: false,
            valid: false,
        };
    }

    if (!mdatBox) {
        return {
            newBuffer: inputBytes.buffer,
            newBytes: inputBytes,
            newView: inputView,
            changed: false,
            valid: true,
        };
    }

    const moovBeforeMdat = moovBox.offset < mdatBox.offset;
    let needsFtypRewrite = false;
    let ftypBytes = null;

    if (ftypBox) {
        const ftypContent = inputBytes.subarray(
            ftypBox.offset + getBoxHeaderSize(ftypBox),
            ftypBox.end,
        );
        const majorBrand = String.fromCharCode(
            ftypContent[0],
            ftypContent[1],
            ftypContent[2],
            ftypContent[3],
        );
        if (majorBrand !== "isom") {
            needsFtypRewrite = true;
            const codec = detectVideoCodecFromMoov(inputBytes, inputView, moovBox);
            const isHevc = codec === "hvc1" || codec === "hev1";
            ftypBytes = buildFtyp(isHevc);
        }
    }

    if (moovBeforeMdat && !needsFtypRewrite) {
        return {
            newBuffer: inputBytes.buffer,
            newBytes: inputBytes,
            newView: inputView,
            changed: false,
            valid: true,
        };
    }

    const ftypSize =
        needsFtypRewrite && ftypBytes
            ? ftypBytes.length
            : ftypBox
              ? ftypBox.size
              : 0;
    const moovSize = moovBox.size;
    const mdatSize = mdatBox.size;
    const newSize = ftypSize + moovSize + mdatSize;

    const newBuffer = new ArrayBuffer(newSize);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);

    let writePos = 0;

    if (needsFtypRewrite && ftypBytes) {
        newBytes.set(ftypBytes, writePos);
        writePos += ftypBytes.length;
    } else if (ftypBox) {
        newBytes.set(inputBytes.subarray(ftypBox.offset, ftypBox.end), writePos);
        writePos += ftypBox.size;
    }

    newBytes.set(inputBytes.subarray(moovBox.offset, moovBox.end), writePos);
    const newMoovOffset = writePos;
    writePos += moovBox.size;

    newBytes.set(inputBytes.subarray(mdatBox.offset, mdatBox.end), writePos);
    writePos += mdatBox.size;

    const newMdatOffset = newMoovOffset + moovBox.size;
    const chunkOffsetDelta = newMdatOffset - mdatBox.offset;

    if (chunkOffsetDelta !== 0) {
        updateChunkOffsets(
            newBytes,
            newView,
            newMoovOffset + getBoxHeaderSize({ offset: newMoovOffset, size: moovBox.size }),
            newMoovOffset + moovBox.size,
            chunkOffsetDelta,
        );
    }

    return { newBuffer, newBytes, newView, changed: true, valid: true };
}
