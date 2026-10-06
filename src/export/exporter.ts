// ─────────────────────────────────────────────────────────────────────────────
// Client-side master export (runs inside the render worker).
//   MP4 / H.264 (or HEVC/AV1 fallback) and WebM / VP9 via WebCodecs + mediabunny muxers,
//   WebM VP9 with alpha, animated GIF (gifenc, per-frame palette quantisation),
//   and lossless RGBA PNG sequences packed into a ZIP (fflate).
// Frames are rendered at full quality (motion blur, DOF) one at a time with encoder backpressure.
// ─────────────────────────────────────────────────────────────────────────────

import {
  AudioSample, AudioSampleSource, BufferTarget, Mp4OutputFormat, Output, Quality, VideoSample, VideoSampleSource, WebMOutputFormat,
  canEncodeAudio, getFirstEncodableVideoCodec, type AudioCodec, type VideoCodec,
} from 'mediabunny';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { zipSync } from 'fflate';
import type { ExportJob, FromWorker } from '../render/protocol';
import { collectVideoNeeds, type Renderer } from '../render/renderer';
import type { WorkerAssets } from '../render/assets';
import { exactFps } from '../core/time';

export interface ExportDeps {
  renderer: Renderer;
  assets: WorkerAssets;
  post: (m: FromWorker, transfer?: Transferable[]) => void;
  cancelled: () => boolean;
}

const yieldLoop = () => new Promise<void>((r) => setTimeout(r, 0));

export async function runExport(job: ExportJob, deps: ExportDeps): Promise<void> {
  const { renderer, assets, post } = deps;
  const project = renderer.project;
  const comp = project.comps[job.compId];
  if (!comp) throw new Error('Composition not found');
  const isVideo = job.format === 'mp4' || job.format === 'webm' || job.format === 'webm-alpha';
  const fps = job.format === 'gif' ? Math.min(exactFps(comp.frameRate), job.gifFps ?? 20) : exactFps(comp.frameRate);
  const total = Math.max(1, Math.round((job.end - job.start) * fps));
  let W = Math.max(2, Math.round(comp.width * job.scale));
  let H = Math.max(2, Math.round(comp.height * job.scale));
  if (isVideo) {
    W -= W % 2;
    H -= H % 2;
  }
  const scale = W / comp.width;
  const alpha = job.format === 'webm-alpha' || job.format === 'png' || job.format === 'gif';
  const canvas = renderer.glc.canvas as OffscreenCanvas;

  // ── encoders ──
  let output: Output | null = null;
  let videoSource: VideoSampleSource | null = null;
  let audioSource: AudioSampleSource | null = null;
  const gif = job.format === 'gif' ? GIFEncoder() : null;
  const pngs: Record<string, Uint8Array> = {};

  if (isVideo) {
    const quality = new Quality(job.quality);
    const webm = job.format !== 'mp4';
    const candidates: VideoCodec[] = webm ? ['vp9', 'vp8', 'av1'] : ['avc', 'hevc', 'av1', 'vp9'];
    const codec = await getFirstEncodableVideoCodec(candidates, { width: W, height: H, quality });
    if (!codec) throw new Error('No supported video encoder found for this resolution (WebCodecs).');
    output = new Output({
      format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    videoSource = new VideoSampleSource({
      codec,
      quality,
      keyFrameInterval: 2,
      alpha: job.format === 'webm-alpha' ? 'keep' : 'discard',
    });
    output.addVideoTrack(videoSource, { frameRate: fps });
    if (job.audio && job.audio.channels.length) {
      const audioCodecs: AudioCodec[] = webm ? ['opus', 'vorbis'] : ['aac', 'opus', 'mp3'];
      let ac: AudioCodec | null = null;
      for (const c of audioCodecs) {
        if (await canEncodeAudio(c, { numberOfChannels: job.audio.channels.length, sampleRate: job.audio.sampleRate })) {
          ac = c;
          break;
        }
      }
      if (ac) {
        audioSource = new AudioSampleSource({ codec: ac, quality: new Quality('high') });
        output.addAudioTrack(audioSource);
      } else post({ type: 'log', level: 'warn', message: 'No supported audio encoder; exporting video only.' });
    }
    await output.start();
  }

  const t0 = performance.now();
  for (let f = 0; f < total; f++) {
    if (deps.cancelled()) {
      if (output) await output.cancel();
      throw new Error('cancelled');
    }
    const t = job.start + f / fps;
    const needs = new Map<string, number[]>();
    collectVideoNeeds(project, comp, t, needs);
    if (needs.size) await assets.prepare(needs);
    const r = renderer.render({ compId: comp.id, time: t, scale, motionBlur: job.motionBlur, guides: false, draft: false });
    if (!r) throw new Error('render failed');
    renderer.present(r.tex, alpha ? null : comp.bgColor);
    // snapshot the preview immediately: viewer renders may interleave on the shared canvas during awaits
    const previewP: Promise<ImageBitmap | null> | null = f % 8 === 0 || f === total - 1
      ? createImageBitmap(canvas, { resizeWidth: 320, resizeHeight: Math.max(1, Math.round((320 * H) / W)), resizeQuality: 'medium' }).catch(() => null)
      : null;

    if (videoSource) {
      const sample = new VideoSample(canvas, { timestamp: f / fps, duration: 1 / fps });
      await videoSource.add(sample);
      sample.close();
    } else if (gif) {
      const px = renderer.readPixels(r.tex);
      // composite over nothing: unpremultiply for GIF
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3];
        if (a > 0 && a < 255) {
          px[i] = Math.min(255, Math.round((px[i] * 255) / a));
          px[i + 1] = Math.min(255, Math.round((px[i + 1] * 255) / a));
          px[i + 2] = Math.min(255, Math.round((px[i + 2] * 255) / a));
        }
      }
      const hasAlpha = px.some((v, i) => i % 4 === 3 && v < 128);
      const palette = quantize(px, 256, hasAlpha ? { format: 'rgba4444', oneBitAlpha: true } : { format: 'rgb565' });
      const index = applyPalette(px, palette, hasAlpha ? 'rgba4444' : 'rgb565');
      const transparentIndex = hasAlpha ? palette.findIndex((c) => c[3] === 0) : -1;
      gif.writeFrame(index, W, H, {
        palette, delay: Math.round(1000 / fps), repeat: 0,
        transparent: transparentIndex >= 0, transparentIndex: Math.max(0, transparentIndex), dispose: hasAlpha ? 2 : -1,
      });
    } else {
      const blob = 'convertToBlob' in canvas
        ? await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' })
        : await new Promise<Blob | null>((r) => (canvas as unknown as HTMLCanvasElement).toBlob(r, 'image/png'));
      if (blob) {
        pngs[`${job.filename.replace(/\.zip$/i, '')}_${String(f).padStart(5, '0')}.png`] = new Uint8Array(await blob.arrayBuffer());
      }
    }
    renderer.endFrame();

    const elapsed = (performance.now() - t0) / 1000;
    const preview = previewP ? await previewP : null;
    post({ type: 'exportProgress', jobId: job.jobId, frame: f + 1, total, preview, fps: (f + 1) / Math.max(elapsed, 1e-3) }, preview ? [preview] : []);
    if (f % 4 === 3) await yieldLoop();
  }

  let blob: Blob;
  if (output && videoSource) {
    videoSource.close();
    if (audioSource && job.audio) {
      const { channels, sampleRate } = job.audio;
      const n = channels[0].length;
      const maxFrames = Math.min(n, Math.ceil((job.end - job.start) * sampleRate));
      const chunk = sampleRate; // 1s chunks
      for (let s = 0; s < maxFrames; s += chunk) {
        const len = Math.min(chunk, maxFrames - s);
        const inter = new Float32Array(len * channels.length);
        for (let i = 0; i < len; i++) for (let c = 0; c < channels.length; c++) inter[i * channels.length + c] = channels[c][s + i];
        const as = new AudioSample({ data: inter, format: 'f32', numberOfChannels: channels.length, sampleRate, timestamp: s / sampleRate });
        await audioSource.add(as);
        as.close();
      }
      audioSource.close();
    }
    await output.finalize();
    const buf = (output.target as BufferTarget).buffer;
    if (!buf) throw new Error('encoder produced no data');
    blob = new Blob([buf], { type: job.format === 'mp4' ? 'video/mp4' : 'video/webm' });
  } else if (gif) {
    gif.finish();
    blob = new Blob([gif.bytes().slice().buffer as ArrayBuffer], { type: 'image/gif' });
  } else {
    const zipped = zipSync(pngs, { level: 0 });
    blob = new Blob([zipped.slice().buffer as ArrayBuffer], { type: 'application/zip' });
  }
  post({ type: 'exportDone', jobId: job.jobId, blob, filename: job.filename });
}
