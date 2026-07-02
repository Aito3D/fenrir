import { describe, it, expect } from 'vitest';
import { parseGridFrames } from '../../hooks/useGridStream';

function buildFrame(printerId: number, jpegData: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(8);
  const view = new DataView(header);
  view.setUint32(0, printerId, true);
  view.setUint32(4, jpegData.length, true);
  const frame = new Uint8Array(8 + jpegData.length);
  frame.set(new Uint8Array(header), 0);
  frame.set(jpegData, 8);
  return frame;
}

describe('parseGridFrames', () => {
  it('parses a single complete frame', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0x00, 0xff, 0xd9]);
    const buf = buildFrame(42, jpeg);
    const { frames, bytesConsumed } = parseGridFrames(buf.buffer, 0, buf.length);
    expect(frames).toHaveLength(1);
    expect(frames[0].printerId).toBe(42);
    expect(new Uint8Array(frames[0].jpeg)).toEqual(jpeg);
    expect(bytesConsumed).toBe(13);
  });

  it('parses multiple frames', () => {
    const f1 = buildFrame(1, new Uint8Array([0x01, 0x02]));
    const f2 = buildFrame(2, new Uint8Array([0x03]));
    const combined = new Uint8Array(f1.length + f2.length);
    combined.set(f1, 0);
    combined.set(f2, f1.length);

    const { frames, bytesConsumed } = parseGridFrames(combined.buffer, 0, combined.length);
    expect(frames).toHaveLength(2);
    expect(frames[0].printerId).toBe(1);
    expect(frames[1].printerId).toBe(2);
    expect(bytesConsumed).toBe(combined.length);
  });

  it('stops at incomplete frame', () => {
    const jpeg = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const full = buildFrame(5, jpeg);
    const truncated = full.slice(0, full.length - 2); // cut off last 2 bytes

    const { frames, bytesConsumed } = parseGridFrames(truncated.buffer, 0, truncated.length);
    expect(frames).toHaveLength(0);
    expect(bytesConsumed).toBe(0);
  });

  it('detects corrupt header (oversized jpegLen)', () => {
    const header = new ArrayBuffer(8);
    const view = new DataView(header);
    view.setUint32(0, 1, true);
    view.setUint32(4, 20_000_000, true); // > 10 MB cap
    const buf = new Uint8Array(header);

    const { frames, bytesConsumed } = parseGridFrames(buf.buffer, 0, buf.length);
    expect(frames).toHaveLength(0);
    expect(bytesConsumed).toBe(-1); // corruption signal
  });

  it('handles byteOffset correctly', () => {
    const jpeg = new Uint8Array([0xAA]);
    const frame = buildFrame(99, jpeg);
    const padded = new Uint8Array(10 + frame.length);
    padded.set(frame, 10);

    const { frames, bytesConsumed } = parseGridFrames(padded.buffer, 10, frame.length);
    expect(frames).toHaveLength(1);
    expect(frames[0].printerId).toBe(99);
    expect(bytesConsumed).toBe(frame.length);
  });

  it('returns empty for zero-length buffer', () => {
    const { frames, bytesConsumed } = parseGridFrames(new ArrayBuffer(0), 0, 0);
    expect(frames).toHaveLength(0);
    expect(bytesConsumed).toBe(0);
  });
});
