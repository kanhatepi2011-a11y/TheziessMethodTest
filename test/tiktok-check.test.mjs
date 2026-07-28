import { describe, expect, it } from "vitest";
import { extractClaimedFps, extractTikTokDataFromHtml } from "../api/tiktok/check.js";

describe("TikTok video checker metadata parser", () => {
  it("extracts resolution, bitrate, fps, duration and size", () => {
    const state = {
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": {
          itemInfo: {
            itemStruct: {
              id: "1234567890123456789",
              desc: "Sample TikTok video",
              author: { uniqueId: "sampleuser" },
              video: {
                width: 1080,
                height: 1920,
                duration: 15,
                bitrateInfo: [
                  {
                    Bitrate: 1450000,
                    FPS: 30,
                    DataSize: 2718750,
                    CodecType: "h264",
                    PlayAddr: {
                      UrlList: ["https://v16.tiktokcdn.com/video.mp4"],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };

    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(state)}</script>`;
    const result = extractTikTokDataFromHtml(
      html,
      "https://www.tiktok.com/@sampleuser/video/1234567890123456789",
    );

    expect(result.videoId).toBe("1234567890123456789");
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.bitrate).toBe(1450000);
    expect(result.fps).toBe(30);
    expect(result.duration).toBe(15);
    expect(result.fileSize).toBe(2718750);
  });
});


describe("TikTok FPS caption fallback", () => {
  it("reads an explicit FPS hashtag before a typo-like FPA value", () => {
    expect(extractClaimedFps("Test 600Fpa 😀 #120fps")).toBe(120);
  });

  it("supports high claimed frame-rate values without forcing a common preset", () => {
    expect(extractClaimedFps("Experimental render #1200fps")).toBe(1200);
    expect(extractClaimedFps("Test clip 6000 FPS")).toBe(6000);
  });
});
