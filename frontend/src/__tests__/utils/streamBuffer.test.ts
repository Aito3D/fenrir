import { describe, expect, it } from 'vitest';
import { GrowingBuffer } from '../../utils/streamBuffer';

describe('GrowingBuffer.append', () => {
  it('grows the backing array by doubling while preserving previously-written bytes', () => {
    const gb = new GrowingBuffer(4, 1024);
    expect(gb.buffer.byteLength).toBe(4);

    gb.append(new Uint8Array([1, 2, 3]));
    expect(gb.length).toBe(3);
    expect(gb.buffer.byteLength).toBe(4); // fits, no growth yet
    expect(Array.from(gb.data)).toEqual([1, 2, 3]);

    // 3 + 3 = 6 > current capacity (4); doubles once to 8.
    gb.append(new Uint8Array([4, 5, 6]));
    expect(gb.length).toBe(6);
    expect(gb.buffer.byteLength).toBe(8);
    expect(Array.from(gb.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('doubles repeatedly until the chunk fits', () => {
    const gb = new GrowingBuffer(4, 1024);
    // 0 + 20 = 20 > 4; doubling sequence is 4 -> 8 -> 16 -> 32.
    gb.append(new Uint8Array(20).fill(7));
    expect(gb.length).toBe(20);
    expect(gb.buffer.byteLength).toBe(32);
    expect(gb.data.every((b) => b === 7)).toBe(true);
  });

  it('throws a RangeError once the doubled size would exceed maxSize, leaving state unchanged', () => {
    const gb = new GrowingBuffer(4, 8);

    // First append grows 4 -> 8, which is exactly maxSize, so it is allowed.
    gb.append(new Uint8Array([1, 2, 3, 4, 5]));
    expect(gb.length).toBe(5);
    expect(gb.buffer.byteLength).toBe(8);

    // Second append needs 5 + 5 = 10 > 8; doubling wants 16, which exceeds maxSize (8).
    expect(() => gb.append(new Uint8Array([6, 7, 8, 9, 10]))).toThrow(RangeError);
    expect(() => gb.append(new Uint8Array([6, 7, 8, 9, 10]))).toThrow(
      'Buffer exceeded 8 bytes (requested 16)',
    );

    // The failed append must not have mutated the buffer.
    expect(gb.length).toBe(5);
    expect(gb.buffer.byteLength).toBe(8);
    expect(Array.from(gb.data)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('GrowingBuffer.compact', () => {
  it('shifts remaining bytes to index 0 and reduces length accordingly', () => {
    const gb = new GrowingBuffer(8, 64);
    gb.append(new Uint8Array([10, 20, 30, 40, 50]));

    gb.compact(2);

    expect(gb.length).toBe(3);
    expect(Array.from(gb.data)).toEqual([30, 40, 50]);
  });

  it('is a no-op when offset is zero or negative', () => {
    const gb = new GrowingBuffer(8, 64);
    gb.append(new Uint8Array([1, 2, 3]));

    gb.compact(0);
    expect(gb.length).toBe(3);
    expect(Array.from(gb.data)).toEqual([1, 2, 3]);

    gb.compact(-5);
    expect(gb.length).toBe(3);
    expect(Array.from(gb.data)).toEqual([1, 2, 3]);
  });
});

describe('GrowingBuffer.shrinkIfSparse', () => {
  it('reallocates a smaller backing array once usage drops below 1/4 of capacity', () => {
    const gb = new GrowingBuffer(4, 1024);
    // Forces growth to 16 (4 -> 8 -> 16 to fit 10 bytes).
    gb.append(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(gb.buffer.byteLength).toBe(16);

    // Drop usage to 2 bytes, which is below 16 / 4 = 4.
    gb.compact(8);
    expect(gb.length).toBe(2);
    expect(Array.from(gb.data)).toEqual([9, 10]);

    gb.shrinkIfSparse();

    // newSize = max(initialSize=4, len*2=4) = 4
    expect(gb.buffer.byteLength).toBe(4);
    expect(gb.length).toBe(2);
    expect(Array.from(gb.data)).toEqual([9, 10]);
  });

  it('does nothing when the backing array is still at (or below) the initial size', () => {
    const gb = new GrowingBuffer(8, 64);
    gb.append(new Uint8Array([1]));

    gb.shrinkIfSparse();

    expect(gb.buffer.byteLength).toBe(8);
    expect(gb.length).toBe(1);
  });

  it('does nothing when usage is at or above 1/4 of capacity', () => {
    const gb = new GrowingBuffer(4, 1024);
    // Force growth to 8, then keep usage at 4/8 = 1/2 (not sparse).
    gb.append(new Uint8Array([1, 2, 3, 4, 5]));
    expect(gb.buffer.byteLength).toBe(8);
    gb.compact(1);
    expect(gb.length).toBe(4);

    gb.shrinkIfSparse();

    expect(gb.buffer.byteLength).toBe(8);
    expect(gb.length).toBe(4);
  });
});

describe('GrowingBuffer.reset', () => {
  it('zeroes length without touching the underlying bytes', () => {
    const gb = new GrowingBuffer(8, 64);
    gb.append(new Uint8Array([1, 2, 3, 4]));

    gb.reset();

    expect(gb.length).toBe(0);
    expect(gb.data.length).toBe(0);
    // No reallocation happens on reset.
    expect(gb.buffer.byteLength).toBe(8);

    // The raw bytes are still physically present in the backing array;
    // only the logical length was zeroed.
    const raw = new Uint8Array(gb.buffer, gb.byteOffset, 4);
    expect(Array.from(raw)).toEqual([1, 2, 3, 4]);

    // A subsequent append starts writing from index 0 again.
    gb.append(new Uint8Array([9, 9]));
    expect(gb.length).toBe(2);
    expect(Array.from(gb.data)).toEqual([9, 9]);
  });
});
