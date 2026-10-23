/**
 * Typed input schema of vivid_create_editor_project / vivid_edit_timeline:
 * one object per editor operation (vivid-editor-core AiCommand), each with its
 * own payload. The v2 commands (keyframes, effects, masks, recipes) reuse the
 * core's own validators; the v1 ones are written here from the core's types.
 * TextOverlay / CanvasObject patches keep extra style fields (`.loose()`): the
 * core owns their full shape and the orchestrator ignores what it does not know.
 */
import { z } from 'zod';
import {
  SetObjectAnimationSchema, AddEffectSchema, RemoveEffectSchema, SetEffectKeyframesSchema,
  AddAudioReactiveSchema, SetMaskSchema, SetAnimationsSchema, ApplyEffectRecipeSchema,
} from 'vivid-editor-core';

const ms = z.number().min(0);
const unit = z.number().min(0).max(1);
const ANIM = z.enum(['none', 'fade', 'slide-up', 'slide-down', 'zoom-in', 'zoom-out', 'zoom-pan', 'spin', 'blur-reveal']);
const BLEND = z.enum(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion']);
const LOOK = z.enum(['none', 'kodak-portra', 'noir', 'cyberpunk', 'kodak-portra-400', 'fuji-provia', 'ilford-hp5', 'cinestill-800t', 'bleach-bypass', 'polaroid-vintage', 'technicolor', 'cross-process', 'muted-cinematic', 'cyberpunk-neon']);

const textFill = z.object({
  type: z.literal('gradient'),
  colors: z.array(z.string()).min(2).max(8),
  angle: z.number().optional(),
  animate: z.enum(['shift', 'none']).optional(),
  speed: z.number().positive().optional(),
});

const textFields = {
  text: z.string(),
  startMs: ms, endMs: ms,
  x: unit.describe('0–1 of the canvas width'), y: unit.describe('0–1 of the canvas height'),
  scale: z.number().positive().optional(), rotation: z.number().optional(),
  fontFamily: z.string().optional(), fontSize: z.number().positive().optional(), fontWeight: z.number().optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  color: z.string().optional(), fill: textFill.optional(),
  backgroundColor: z.string().optional(), backgroundOpacity: unit.optional(),
  strokeColor: z.string().optional(), strokeWidth: z.number().min(0).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(), textTransform: z.enum(['none', 'uppercase']).optional(),
  opacity: unit.optional(),
  animation: z.enum(['none', 'fade-in', 'fade-out', 'fade-in-out', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'pop', 'typewriter', 'bounce', 'blur-in', 'scale-up']).optional(),
  animationIn: z.object({ type: ANIM, durationMs: ms }).optional(),
  animationOut: z.object({ type: ANIM, durationMs: ms }).optional(),
};

const canvasPatch = {
  x: z.number().optional(), y: z.number().optional(), w: z.number().positive().optional(), h: z.number().positive().optional(),
  rotation: z.number().optional(), opacity: unit.optional(), blendMode: BLEND.optional(),
};

const cmd = <T extends string, P extends z.ZodType>(type: T, payload: P) => z.object({ type: z.literal(type), payload });

export const commandSchema = z.discriminatedUnion('type', [
  // timeline
  cmd('ADD_CLIP', z.object({
    assetId: z.string().describe('Local id of a media item in the project library.'),
    startMs: ms.optional(), durationMs: z.number().positive().optional(), trackId: z.string().optional(),
    canvasObject: z.object(canvasPatch).loose().optional(),
  })),
  cmd('UPDATE_CLIP', z.object({
    id: z.string(), startMs: ms.optional(), durationMs: z.number().positive().optional(), sourceOffsetMs: ms.optional(),
    playbackRate: z.number().min(0.1).max(8).optional(), volume: z.number().min(0).max(2).optional(), opacity: unit.optional(),
  })),
  cmd('REMOVE_CLIP', z.object({ id: z.string() })),
  cmd('SPLIT_CLIP', z.object({ clipId: z.string(), splitAtMs: ms })),
  cmd('DUPLICATE_CLIP', z.object({ id: z.string() })),
  cmd('DETACH_AUDIO', z.object({ clipId: z.string() })),
  cmd('ADD_TRACK', z.object({ type: z.enum(['visual', 'audio']) })),
  cmd('CUT_TO_BEAT', z.object({
    audioClipId: z.string(), beatInterval: z.number().int().min(1).max(32),
    grid: z.enum(['beats', 'peaks']).optional(), minStrength: unit.optional(),
    mode: z.enum(['redistribute', 'snap']).optional(),
    syncClips: z.union([z.literal('all'), z.array(z.string())]).optional(),
  })),
  cmd('SET_SPEED_RAMP', z.object({
    clipId: z.string(),
    preset: z.enum(['speed-up', 'slow-down', 'slow-mo-hit', 'punch-in', 'ease-in-out', 'none']).optional(),
    keyframes: z.array(z.object({ t: ms, v: z.number().min(0.1).max(8) })).nullable().optional(),
  })),
  // look
  cmd('SET_TRANSITION', z.object({
    clipId: z.string(), edge: z.enum(['in', 'out']),
    type: z.enum(['dissolve', 'fade-black', 'crossfade', 'fade-in', 'fade-out']), durationMs: ms,
  })),
  cmd('SET_CLIP_ANIMATION', z.object({ clipId: z.string(), phase: z.enum(['in', 'out']), type: ANIM, durationMs: ms })),
  cmd('SET_CINEMATIC_LOOK', z.object({ look: LOOK })),
  cmd('SET_CANVAS_PRESET', z.object({ id: z.string(), label: z.string(), width: z.number().int().positive(), height: z.number().int().positive() })),
  cmd('UPDATE_CANVAS_OBJECT', z.object({ id: z.string(), ...canvasPatch }).loose()),
  // text
  cmd('ADD_TEXT', z.object({ id: z.string().optional(), ...textFields }).loose()),
  cmd('UPDATE_TEXT', z.object({ id: z.string() }).extend(z.object(textFields).partial().shape).loose()),
  cmd('REMOVE_TEXT', z.object({ id: z.string() })),
  cmd('SET_SUBTITLES', z.object({
    cues: z.array(z.object({
      text: z.string(), startMs: ms, endMs: ms,
      words: z.array(z.object({ word: z.string(), startMs: ms, endMs: ms })).optional(),
    })).nullable().optional(),
    templateId: z.enum(['outline-reveal', 'ugc-pop', 'karaoke-marker', 'cinematic-fade', 'neon-cyberpunk', 'playful-wiggle']).optional(),
    position: z.number().min(0).max(100).optional(),
    styleOverrides: z.object({
      fontSize: z.number().positive().optional(), color: z.string().optional(), highlightColor: z.string().optional(),
    }).loose().optional(),
    layout: z.object({
      x: unit.optional(), y: unit.optional(), scale: z.number().positive().optional(),
      maxWidthPct: unit.optional(), maxHeightPct: unit.optional(), rotation: z.number().optional(),
    }).optional(),
  })),
  // keyframes, effects, masks, recipes (validators from vivid-editor-core)
  SetObjectAnimationSchema, SetAnimationsSchema, AddEffectSchema, RemoveEffectSchema, SetEffectKeyframesSchema,
  AddAudioReactiveSchema, SetMaskSchema, ApplyEffectRecipeSchema,
]);

export const commandsSchema = z.array(commandSchema);
