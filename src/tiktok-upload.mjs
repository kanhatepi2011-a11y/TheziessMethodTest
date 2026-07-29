import {
    detectVideoCodecFromMoov,
    findHandlerType,
    getBoxHeaderSize,
    parseBoxes,
} from "./mp4-boxes.mjs";

export const TIKTOK_MEDIA_LIMITS = Object.freeze({
    minFps: 23,
    maxFps: 60,
    minDimension: 360,
    maxDimension: 4096,
    maxDurationSeconds: 600,
    maxBytes: 4 * 1024 * 1024 * 1024,
});

function childBoxes(bytes, view, box) {
    return parseBoxes(bytes, view, box.offset + getBoxHeaderSize(box), box.end);
}

function findDescendant(bytes, view, box, type) {
    const stack = [...childBoxes(bytes, view, box)];
    while (stack.length) {
        const current = stack.shift();
        if (current.type === type) return current;
        if (["trak", "mdia", "minf", "stbl"].includes(current.type)) {
            stack.push(...childBoxes(bytes, view, current));
        }
    }
    return null;
}

function parseTrackDimensions(bytes, view, trak) {
    const tkhd = childBoxes(bytes, view, trak).find((box) => box.type === "tkhd");
    if (!tkhd) return null;
    const start = tkhd.offset + getBoxHeaderSize(tkhd);
    const version = bytes[start];
    const matrixOffset = start + (version === 1 ? 52 : 40);
    const widthOffset = start + (version === 1 ? 88 : 76);
    if (widthOffset + 8 > tkhd.end) return null;
    let width = view.getUint32(widthOffset, false) / 65536;
    let height = view.getUint32(widthOffset + 4, false) / 65536;
    if (matrixOffset + 36 <= tkhd.end) {
        const a = view.getInt32(matrixOffset, false);
        const b = view.getInt32(matrixOffset + 4, false);
        if (Math.abs(a) < 1000 && Math.abs(b) > 60000) {
            [width, height] = [height, width];
        }
    }
    return { width: Math.round(width), height: Math.round(height) };
}

function parseMdhd(bytes, view, mdhd) {
    const start = mdhd.offset + getBoxHeaderSize(mdhd);
    const version = bytes[start];
    if (version === 1) {
        if (start + 32 > mdhd.end) return null;
        const timescale = view.getUint32(start + 20, false);
        const duration = Number(view.getBigUint64(start + 24, false));
        return { timescale, duration };
    }
    if (start + 20 > mdhd.end) return null;
    return {
        timescale: view.getUint32(start + 12, false),
        duration: view.getUint32(start + 16, false),
    };
}

function parseStts(view, stts) {
    const start = stts.offset + getBoxHeaderSize(stts);
    if (start + 8 > stts.end) return null;
    const entryCount = view.getUint32(start + 4, false);
    let offset = start + 8;
    let totalSamples = 0;
    let totalTicks = 0;
    for (let index = 0; index < entryCount; index += 1) {
        if (offset + 8 > stts.end) return null;
        const sampleCount = view.getUint32(offset, false);
        const sampleDelta = view.getUint32(offset + 4, false);
        totalSamples += sampleCount;
        totalTicks += sampleCount * sampleDelta;
        offset += 8;
    }
    return { totalSamples, totalTicks };
}

export function inspectMp4ForTikTok(buffer, mimeType = "video/mp4") {
    const arrayBuffer = buffer instanceof ArrayBuffer
        ? buffer
        : buffer?.buffer?.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    if (!(arrayBuffer instanceof ArrayBuffer)) {
        throw new Error("TikTok artifact must be an ArrayBuffer.");
    }

    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const top = parseBoxes(bytes, view, 0, bytes.length);
    const moov = top.find((box) => box.type === "moov");
    if (!moov) throw new Error("TikTok artifact is missing MP4 metadata.");

    let trackInfo = null;
    for (const trak of childBoxes(bytes, view, moov).filter((box) => box.type === "trak")) {
        const hdlr = findDescendant(bytes, view, trak, "hdlr");
        if (!hdlr || findHandlerType(bytes, hdlr) !== "vide") continue;
        const mdhd = findDescendant(bytes, view, trak, "mdhd");
        const stts = findDescendant(bytes, view, trak, "stts");
        const dimensions = parseTrackDimensions(bytes, view, trak);
        const timing = mdhd ? parseMdhd(bytes, view, mdhd) : null;
        const samples = stts ? parseStts(view, stts) : null;
        if (!dimensions || !timing?.timescale) continue;
        const duration = samples?.totalTicks
            ? samples.totalTicks / timing.timescale
            : timing.duration / timing.timescale;
        const fps = samples?.totalSamples && duration > 0
            ? samples.totalSamples / duration
            : null;
        trackInfo = {
            ...dimensions,
            duration,
            fps,
            sampleCount: samples?.totalSamples || null,
        };
        break;
    }

    if (!trackInfo) throw new Error("TikTok artifact has no readable video track.");
    const codec = detectVideoCodecFromMoov(bytes, view, moov);
    return {
        ...trackInfo,
        codec: codec || null,
        mimeType: String(mimeType || "video/mp4").split(";", 1)[0].toLowerCase(),
        byteSize: bytes.byteLength,
    };
}

export function validateTikTokArtifact(metadata) {
    const errors = [];
    const width = Number(metadata?.width);
    const height = Number(metadata?.height);
    const fps = Number(metadata?.fps);
    const duration = Number(metadata?.duration);
    const byteSize = Number(metadata?.byteSize);
    const mimeType = String(metadata?.mimeType || "").toLowerCase();
    const codec = String(metadata?.codec || "").toLowerCase();

    if (!["video/mp4", "video/quicktime", "video/webm"].includes(mimeType)) {
        errors.push({ code: "mime", message: "TikTok supports MP4, MOV, or WebM." });
    }
    if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > TIKTOK_MEDIA_LIMITS.maxBytes) {
        errors.push({ code: "size", message: "Video must be smaller than 4 GB." });
    }
    if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width < TIKTOK_MEDIA_LIMITS.minDimension ||
        height < TIKTOK_MEDIA_LIMITS.minDimension ||
        width > TIKTOK_MEDIA_LIMITS.maxDimension ||
        height > TIKTOK_MEDIA_LIMITS.maxDimension
    ) {
        errors.push({ code: "dimensions", message: "Video dimensions must be 360–4096 pixels on both sides." });
    }
    if (!Number.isFinite(fps) || fps < TIKTOK_MEDIA_LIMITS.minFps || fps > TIKTOK_MEDIA_LIMITS.maxFps) {
        errors.push({ code: "fps", message: "Real video FPS must be between 23 and 60." });
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > TIKTOK_MEDIA_LIMITS.maxDurationSeconds) {
        errors.push({ code: "duration", message: "Video duration must be between 1 second and 10 minutes." });
    }
    if (codec && !["avc1", "avc3", "hvc1", "hev1", "vp08", "vp09"].includes(codec)) {
        errors.push({ code: "codec", message: "Video codec is not supported by TikTok." });
    }

    return { valid: errors.length === 0, errors };
}

export function formatRealFps(value) {
    const fps = Number(value);
    if (!Number.isFinite(fps)) return "Unavailable";
    return Number.isInteger(fps) ? String(fps) : fps.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
