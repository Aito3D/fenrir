/**
 * GrowingBuffer — pre-allocated doubling buffer for streaming JPEG parsing.
 *
 * Replaces inline buffer management in useMjpegStream and useGridStream
 * with a shared, tested implementation.
 */
export class GrowingBuffer {
  private buf: Uint8Array;
  private len = 0;
  private readonly initialSize: number;
  private readonly maxSize: number;

  constructor(initialSize = 256 * 1024, maxSize = 5 * 1024 * 1024) {
    this.initialSize = initialSize;
    this.maxSize = maxSize;
    this.buf = new Uint8Array(initialSize);
  }

  /** Append a chunk, growing the buffer by doubling if needed. Throws if maxSize exceeded. */
  append(chunk: Uint8Array): void {
    if (this.len + chunk.length > this.buf.length) {
      let newSize = this.buf.length;
      while (newSize < this.len + chunk.length) newSize *= 2;
      if (newSize > this.maxSize) {
        throw new RangeError(
          `Buffer exceeded ${this.maxSize} bytes (requested ${newSize})`,
        );
      }
      const newBuf = new Uint8Array(newSize);
      newBuf.set(this.buf.subarray(0, this.len));
      this.buf = newBuf;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
  }

  /** Shift consumed bytes to the front of the buffer. */
  compact(offset: number): void {
    if (offset <= 0) return;
    this.buf.copyWithin(0, offset, this.len);
    this.len -= offset;
  }

  /** Shrink backing array if less than 1/4 used (avoids holding large allocations after spikes). */
  shrinkIfSparse(): void {
    if (this.buf.length > this.initialSize && this.len < this.buf.length / 4) {
      const shrunk = new Uint8Array(Math.max(this.initialSize, this.len * 2));
      shrunk.set(this.buf.subarray(0, this.len));
      this.buf = shrunk;
    }
  }

  get data(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  get length(): number {
    return this.len;
  }

  get buffer(): ArrayBuffer {
    return this.buf.buffer as ArrayBuffer;
  }

  get byteOffset(): number {
    return this.buf.byteOffset;
  }

  reset(): void {
    this.len = 0;
  }
}
