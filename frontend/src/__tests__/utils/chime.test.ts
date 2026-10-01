/**
 * The chime's one shared AudioContext: created (or resumed) by the first
 * gesture, reused by every chime. WebKit (iPad) leaves a context created
 * outside a gesture suspended, so a context per chime never made a sound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetChimeForTests, chime, unlockChime } from '../../utils/chime';

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {});
  oscillators = 0;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createOscillator() {
    this.oscillators += 1;
    return { type: '', frequency: { value: 0 }, connect: (n: unknown) => n, start: vi.fn(), stop: vi.fn() };
  }
  createGain() {
    const gain = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: (n: unknown) => n,
    };
    return gain;
  }
}

describe('chime', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    __resetChimeForTests();
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });
  afterEach(() => {
    __resetChimeForTests();
    vi.unstubAllGlobals();
  });

  it('creates no context until the first gesture, then creates and resumes one', () => {
    const remove = unlockChime();
    expect(FakeAudioContext.instances).toHaveLength(0);
    window.dispatchEvent(new Event('pointerdown'));
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(1);
    // One-time: a later gesture creates nothing more.
    window.dispatchEvent(new Event('keydown'));
    expect(FakeAudioContext.instances).toHaveLength(1);
    remove();
  });

  it('a keydown unlocks it too', () => {
    unlockChime();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('reuses the one context across chimes and never closes it', () => {
    unlockChime();
    window.dispatchEvent(new Event('pointerdown'));
    chime();
    chime();
    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.oscillators).toBe(4);
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it('resumes a suspended context before it plays', () => {
    unlockChime();
    window.dispatchEvent(new Event('pointerdown'));
    const ctx = FakeAudioContext.instances[0];
    ctx.state = 'suspended'; // the OS can suspend it again (iPad going to sleep)
    ctx.resume.mockClear();
    chime();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it('stays silent while the page has never been interacted with', () => {
    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: false } });
    chime();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('removing the listener before any gesture leaves nothing behind', () => {
    const remove = unlockChime();
    remove();
    window.dispatchEvent(new Event('pointerdown'));
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});
