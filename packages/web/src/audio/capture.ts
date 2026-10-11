/**
 * MAME audio capture (T41). MAME's browser sound backend creates its own
 * `AudioContext` and connects a final `gain_node` straight to
 * `context.destination` (mame/src/osd/modules/sound/js_sound.js), so the mixed
 * audio never touches a node we own. To publish it over LiveKit we intercept
 * `AudioNode.prototype.connect`: whenever a node connects to its context's
 * `destination`, we also connect it to a per-context
 * `MediaStreamAudioDestinationNode`, whose `stream` carries the exact same mix.
 *
 * This is a pure web-side tap: it never changes what the emulator does (audio is
 * an output, outside the deterministic core), so the replay path is untouched.
 */

/** The globals the tap needs; `Window` satisfies this structurally. */
export interface AudioCaptureEnv {
  AudioNode?: { prototype: AudioNode };
  MediaStream?: typeof MediaStream;
}

/** A live tap of the app's audio, or a no-op when the platform lacks the APIs. */
export interface AudioCapture {
  /**
   * A `MediaStream` of the captured audio (all contexts merged), or null until
   * the emulator has produced a context connected to its destination.
   */
  getAudioStream(): MediaStream | null;
  /** Restore `AudioNode.prototype.connect`. */
  dispose(): void;
}

const MARKER = Symbol.for("wma.audioCapture");

interface CaptureState {
  original: AudioNode["connect"];
  destinations: Set<MediaStreamAudioDestinationNode>;
  handle: AudioCapture;
}

interface MarkedPrototype extends AudioNode {
  [MARKER]?: CaptureState;
}

type AnyConnect = (this: AudioNode, destination: unknown, ...rest: unknown[]) => unknown;

/**
 * Install the audio tap on `env` and return a handle. Idempotent: a second
 * install returns the existing handle rather than patching twice.
 */
export function installAudioCapture(env: AudioCaptureEnv): AudioCapture {
  const proto = env.AudioNode?.prototype as MarkedPrototype | undefined;
  const MediaStreamCtor = env.MediaStream;
  if (!proto || typeof proto.connect !== "function") {
    return { getAudioStream: () => null, dispose: () => {} };
  }
  if (proto[MARKER]) return proto[MARKER]!.handle;

  const original = proto.connect;
  const destinations = new Set<MediaStreamAudioDestinationNode>();

  const patched: AnyConnect = function (this: AudioNode, destination, ...rest) {
    const result = (original as AnyConnect).apply(this, [destination, ...rest]);
    const context = this.context as BaseAudioContext & {
      createMediaStreamDestination?: () => MediaStreamAudioDestinationNode;
    };
    if (
      destination === context.destination &&
      typeof context.createMediaStreamDestination === "function"
    ) {
      const dest = context.createMediaStreamDestination();
      destinations.add(dest);
      (original as AnyConnect).apply(this, [dest, ...rest]);
    }
    return result;
  };
  proto.connect = patched as AudioNode["connect"];

  const handle: AudioCapture = {
    getAudioStream(): MediaStream | null {
      const tracks: MediaStreamTrack[] = [];
      for (const dest of destinations) {
        for (const track of dest.stream.getAudioTracks()) tracks.push(track);
      }
      if (tracks.length === 0) return null;
      const first = destinations.values().next().value!;
      if (destinations.size === 1 || !MediaStreamCtor) return first.stream;
      const merged = new MediaStreamCtor();
      for (const track of tracks) merged.addTrack(track);
      return merged;
    },
    dispose(): void {
      proto.connect = original;
      delete proto[MARKER];
    },
  };

  proto[MARKER] = { original, destinations, handle };
  return handle;
}
