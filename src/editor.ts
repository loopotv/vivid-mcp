/**
 * Video editor timeline tools — headless editing on top of `vivid-editor-core`
 * (the same store + AI command orchestrator the vividai.tv editor runs).
 *
 * Flow: download the project JSON (a `script` asset) → open it headless →
 * apply AiCommands → validate → save back with the same asset id. Media
 * enters the project as VIVID assets (id), never as blobs: local files and
 * foreign URLs are uploaded through /api/ai/save-editor-media first.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  CANVAS_PRESETS, emptyProjectFile, openHeadlessProject,
  type AiCommand, type AssetClip, type EditorState, type HeadlessEditor, type ProjectFile,
} from 'vivid-editor-core';
import { VividClient, VividApiError, guessContentType } from './client.js';

const ASSET_ID = /^[a-f0-9]{32}$/i;

export interface AssetRow {
  id: string; type: string; filename: string; mime_type?: string | null; duration_sec?: number | null;
  metadata?: string | Record<string, unknown> | null; job_id?: string | null; created_at: string;
}

export interface MediaImport {
  /** Asset id, http(s) URL or local file path. */
  source: string;
  name?: string;
  /** Override / supply what the API does not know (uploaded videos have no probed duration). */
  durationMs?: number;
  width?: number;
  height?: number;
  /** Local id inside the project; defaults to the asset id. */
  localId?: string;
}

export function editUrlFor(client: VividClient, projectAssetId: string): string {
  const site = client.apiUrl.includes('vividoai') ? 'https://vividai.tv' : client.apiUrl;
  return `${site}/tools/editor?project=${projectAssetId}`;
}

export function resolveAssetUrl(client: VividClient) {
  return (serverAssetId: string) => client.url(`/api/assets/${serverAssetId}/download`);
}

/** MP4/MOV duration from the `mvhd` box; MP3 from CBR size; WAV from RIFF. Null when unknown. */
export function probeDurationMs(bytes: Uint8Array, contentType: string): number | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (contentType.startsWith('video/') || contentType === 'audio/mp4') {
    // Walk top-level boxes to moov, then to mvhd (moov is usually first or last).
    const findBox = (start: number, end: number, type: string): { off: number; size: number } | null => {
      let off = start;
      while (off + 8 <= end) {
        let size = dv.getUint32(off);
        const t = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        let header = 8;
        if (size === 1 && off + 16 <= end) { size = Number(dv.getBigUint64(off + 8)); header = 16; }
        if (size === 0) size = end - off;
        if (size < header) return null;
        if (t === type) return { off: off + header, size: size - header };
        off += size;
      }
      return null;
    };
    const moov = findBox(0, bytes.byteLength, 'moov');
    if (!moov) return null;
    const mvhd = findBox(moov.off, moov.off + moov.size, 'mvhd');
    if (!mvhd) return null;
    const version = bytes[mvhd.off];
    const timescale = version === 1 ? dv.getUint32(mvhd.off + 20) : dv.getUint32(mvhd.off + 12);
    const duration = version === 1 ? Number(dv.getBigUint64(mvhd.off + 24)) : dv.getUint32(mvhd.off + 16);
    return timescale > 0 ? Math.round(duration / timescale * 1000) : null;
  }
  if (contentType === 'audio/wav') {
    if (bytes.byteLength < 44) return null;
    const channels = dv.getUint16(22, true); const sampleRate = dv.getUint32(24, true); const bits = dv.getUint16(34, true);
    const bps = channels * sampleRate * bits / 8;
    return bps > 0 ? Math.round((bytes.byteLength - 44) / bps * 1000) : null;
  }
  if (contentType === 'audio/mpeg') {
    // Constant-bitrate estimate from the first frame header.
    let off = 0;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      off = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
    }
    while (off + 4 < bytes.byteLength && !(bytes[off] === 0xff && (bytes[off + 1] & 0xe0) === 0xe0)) off++;
    if (off + 4 >= bytes.byteLength) return null;
    const versionBits = (bytes[off + 1] >> 3) & 3; const bitrateIdx = (bytes[off + 2] >> 4) & 0xf;
    const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    const kbps = (versionBits === 3 ? v1 : v2)[bitrateIdx];
    return kbps > 0 ? Math.round((bytes.byteLength - off) * 8 / (kbps * 1000) * 1000) : null;
  }
  return null;
}

function mediaTypeOf(row: AssetRow, contentType?: string): AssetClip['mediaType'] {
  const t = row.type || '';
  if (t === 'video' || t === 'audio' || t === 'image') return t;
  const ct = contentType ?? row.mime_type ?? guessContentType(row.filename);
  return ct.startsWith('video/') ? 'video' : ct.startsWith('audio/') ? 'audio' : 'image';
}

/**
 * Turn a MediaImport into an AssetClip backed by a VIVID asset. Local files
 * and non-VIVID URLs are uploaded as editor media; duration comes from the
 * caller, the asset row, the generating job, or a probe of the bytes.
 */
export async function importMedia(client: VividClient, m: MediaImport): Promise<AssetClip> {
  let assetId: string;
  let probed: { bytes: Uint8Array; contentType: string } | null = null;
  if (ASSET_ID.test(m.source)) {
    assetId = m.source;
  } else {
    let bytes: Uint8Array; let contentType: string; let filename: string;
    if (/^https?:\/\//i.test(m.source)) {
      const own = /\/api\/assets\/([a-f0-9]{32})\//i.exec(m.source);
      if (own) { assetId = own[1]; return importMedia(client, { ...m, source: assetId }); }
      const res = await fetch(m.source);
      if (!res.ok) throw new VividApiError(`Could not fetch ${m.source}: HTTP ${res.status}`, res.status);
      bytes = new Uint8Array(await res.arrayBuffer());
      contentType = res.headers.get('content-type')?.split(';')[0] ?? guessContentType(m.source);
      filename = basename(new URL(m.source).pathname) || 'media';
    } else {
      bytes = new Uint8Array(await readFile(m.source));
      contentType = guessContentType(m.source);
      filename = basename(m.source);
    }
    const form = new FormData();
    form.append('file', new Blob([bytes as unknown as ArrayBufferView<ArrayBuffer>], { type: contentType }), m.name ?? filename);
    const { data } = await client.post<{ assetId: string }>('/api/ai/save-editor-media', form);
    assetId = data.assetId;
    probed = { bytes, contentType };
  }

  const { data: row } = await client.get<AssetRow>(`/api/assets/${assetId}`);
  const meta = typeof row.metadata === 'string' ? (() => { try { return JSON.parse(row.metadata as string) as Record<string, unknown>; } catch { return {}; } })() : (row.metadata ?? {});
  const mediaType = mediaTypeOf(row, probed?.contentType);

  let durationMs = m.durationMs ?? (row.duration_sec ? Math.round(row.duration_sec * 1000) : undefined);
  if (!durationMs && mediaType !== 'image' && row.job_id) {
    try {
      const { data: job } = await client.get<{ input?: string | Record<string, unknown> }>(`/api/jobs/${row.job_id}`);
      const input = typeof job.input === 'string' ? JSON.parse(job.input) as Record<string, unknown> : job.input ?? {};
      const d = Number(input.duration ?? input.durationSec);
      if (Number.isFinite(d) && d > 0) durationMs = Math.round(d * 1000);
    } catch { /* job gone — fall through to the probe */ }
  }
  if (!durationMs && mediaType !== 'image') {
    if (!probed) {
      const dl = await client.download(`/api/assets/${assetId}/download`);
      probed = { bytes: dl.bytes, contentType: dl.contentType.split(';')[0] };
    }
    durationMs = probeDurationMs(probed.bytes, probed.contentType) ?? undefined;
  }
  if (!durationMs) durationMs = mediaType === 'image' ? 5000 : 10_000;

  const width = m.width ?? (Number(meta.width) || undefined);
  const height = m.height ?? (Number(meta.height) || undefined);
  return {
    id: m.localId ?? assetId,
    name: m.name ?? row.filename,
    url: resolveAssetUrl(client)(assetId),
    durationMs,
    file: null,
    mediaType,
    intrinsicWidth: width,
    intrinsicHeight: height,
    serverAssetId: assetId,
  };
}

// ── Project I/O ────────────────────────────────────────────────────────────

export async function loadProject(client: VividClient, projectAssetId: string): Promise<{ raw: unknown; editor: HeadlessEditor }> {
  const { bytes } = await client.download(`/api/assets/${projectAssetId}/download`);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new VividApiError(`Asset ${projectAssetId} is not an editor project (invalid JSON)`, 400); }
  return { raw, editor: openHeadlessProject(raw, { resolveUrl: resolveAssetUrl(client) }) };
}

export async function saveProject(client: VividClient, file: ProjectFile, name: string, assetId?: string): Promise<{ assetId: string }> {
  const { data } = await client.post<{ assetId: string; r2Key: string }>('/api/ai/save-editor-project', { projectData: file, name, assetId });
  return { assetId: data.assetId };
}

export function presetFor(id?: string) {
  if (!id) return undefined;
  const p = CANVAS_PRESETS.find((c) => c.id === id) ?? CANVAS_PRESETS.find((c) => c.label.toLowerCase().startsWith(id.toLowerCase()));
  if (!p) throw new VividApiError(`Unknown canvas preset "${id}". Use one of: ${CANVAS_PRESETS.map((c) => c.id).join(', ')}`, 400);
  return p;
}

export function newProject(name: string, presetId?: string): ProjectFile {
  return emptyProjectFile(name, presetFor(presetId));
}

// ── Summary (what the agent reads back) ────────────────────────────────────

export function summarize(state: EditorState, extra: { projectAssetId?: string; editUrl?: string; missingAssets?: string[] } = {}) {
  const durationMs = state.timelineClips.reduce((m, c) => Math.max(m, c.startMs + c.durationMs), 0);
  const assetName = (id: string) => state.assetLibrary.find((a) => a.id === id)?.name;
  return {
    projectAssetId: extra.projectAssetId,
    editUrl: extra.editUrl,
    name: state.projectName,
    canvasPreset: state.canvasPreset,
    durationMs,
    tracks: state.tracks.map((t) => ({ id: t.id, type: t.type, label: t.label })),
    assets: state.assetLibrary.map((a) => ({ id: a.id, name: a.name, mediaType: a.mediaType, durationMs: a.durationMs, width: a.intrinsicWidth, height: a.intrinsicHeight, serverAssetId: a.serverAssetId, bpm: a.bpm })),
    clips: state.timelineClips.map((c) => ({
      id: c.id, trackId: c.trackId, assetId: c.assetId, name: assetName(c.assetId), mediaType: c.mediaType,
      startMs: c.startMs, durationMs: c.durationMs, sourceOffsetMs: c.sourceOffsetMs, playbackRate: c.playbackRate ?? 1,
      volume: c.volume, opacity: c.opacity, transitionIn: c.transitionIn, transitionOut: c.transitionOut,
      animationIn: c.animationIn, animationOut: c.animationOut,
    })),
    canvasObjects: state.canvasObjects.map((o) => ({
      id: o.id, clipId: o.clipId, x: o.x, y: o.y, w: o.w, h: o.h, rotation: o.rotation, blendMode: o.blendMode,
      mask: o.mask && o.mask.type !== 'none' ? o.mask : undefined,
      animations: o.animations && Object.keys(o.animations).length ? Object.keys(o.animations) : undefined,
      effects: o.effects?.map((e) => e.type), maskV2: o.maskV2?.type !== 'none' ? o.maskV2 : undefined,
    })),
    textOverlays: state.textOverlays.map((t) => ({
      id: t.id, text: t.text, startMs: t.startMs, endMs: t.endMs, x: t.x, y: t.y, fontFamily: t.fontFamily, fontSize: t.fontSize, color: t.color, animation: t.animation,
    })),
    cinematicLook: state.cinematicLook,
    missingAssets: extra.missingAssets?.length ? extra.missingAssets : undefined,
  };
}

export type { AiCommand };
