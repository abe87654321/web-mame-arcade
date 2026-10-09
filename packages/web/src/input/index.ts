/** Input layer (T12): devices to per-frame masks, remapping UI. */
export {
  BINDINGS_VERSION,
  DEFAULT_GAMEPAD_BINDINGS,
  DEFAULT_KEYBOARD_BINDINGS,
  DEFAULT_ROOM_BINDINGS,
  emptyFrameInputs,
  playerBindings,
  type Binding,
  type DeviceSlots,
  type InputDevice,
  type PlayerBindings,
  type RoomBindings,
} from "./bindings";
export {
  BUTTON_BITS,
  PLAYER_SLOTS,
  RESERVED_MASK,
  bitFor,
  toWireMask,
  type Button,
} from "./buttons";
export {
  assignDevice,
  findConflicts,
  gamepadConnected,
  gamepadDisconnected,
  releaseDevice,
  sameBinding,
  sameDevice,
  type Conflict,
} from "./devices";
export {
  DEFAULT_DEADZONE,
  DEFAULT_HYSTERESIS,
  createAxisState,
  playerMaskFromPad,
  readGamepads,
  type AxisOptions,
  type AxisState,
  type GamepadButtonLike,
  type GamepadLike,
  type GamepadsProvider,
} from "./gamepad";
export {
  attachKeyboard,
  createKeyState,
  playerMaskFromKeys,
  type AttachKeyboardOptions,
  type KeyState,
  type KeyboardTarget,
} from "./keyboard";
export {
  createSampleState,
  sampleFrameInputs,
  type SampleState,
} from "./sample";
export {
  STORAGE_KEY,
  deserializeRoom,
  loadRoom,
  rebind,
  saveRoom,
  serializeRoom,
  setDevice,
  type StorageLike,
} from "./remap";
export {
  createRemapUi,
  describeBinding,
  describeDevice,
  renderTree,
  type CaptureTarget,
  type RemapUi,
  type RemapUiOptions,
  type UiDocument,
  type UiElement,
  type UiEvent,
  type ViewNode,
} from "./remap-ui";
