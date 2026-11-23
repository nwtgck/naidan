package packedfs

import (
	"context"
	"fmt"
	"sync"

	"github.com/klauspost/compress/zstd"
)

type decodeSlot struct {
	busy    bool
	blockID int
	decoder *zstd.Decoder
	input   []byte
	output  []byte
	lastUse uint64
}

type blockCache struct {
	mu      sync.Mutex
	changed chan struct{}
	slots   []*decodeSlot
	tick    uint64
}

func newBlockCache(count int) *blockCache {
	c := &blockCache{changed: make(chan struct{}), slots: make([]*decodeSlot, count)}
	for i := range c.slots {
		c.slots[i] = &decodeSlot{blockID: -1}
	}
	return c
}

func (c *blockCache) acquire(ctx context.Context, blockID int) (*decodeSlot, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		c.mu.Lock()
		var selected *decodeSlot
		for _, slot := range c.slots {
			if !slot.busy && (selected == nil || slot.blockID == blockID || slot.lastUse < selected.lastUse) {
				selected = slot
				if slot.blockID == blockID {
					break
				}
			}
		}
		if selected != nil {
			selected.busy = true
			c.mu.Unlock()
			return selected, nil
		}
		changed := c.changed
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-changed:
		}
	}
}

func (c *blockCache) release(slot *decodeSlot) {
	c.mu.Lock()
	c.tick++
	slot.lastUse = c.tick
	slot.busy = false
	close(c.changed)
	c.changed = make(chan struct{})
	c.mu.Unlock()
}

func (f *FS) readBlock(ctx context.Context, id int, offset int64, p []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	block := f.blocks[id]
	if block.Codec == Raw {
		copy(p, f.payload[block.Offset+offset:block.Offset+offset+int64(len(p))])
		return nil
	}
	slot, err := f.cache.acquire(ctx, id)
	if err != nil {
		return err
	}
	// A slow client holds only net/http's small copy buffer, never this slot.
	defer f.cache.release(slot)
	if slot.blockID != id {
		slot.blockID = -1
		if slot.decoder == nil {
			slot.decoder, err = zstd.NewReader(nil,
				zstd.WithDecoderConcurrency(1), zstd.WithDecoderLowmem(true),
				zstd.WithDecoderMaxWindow(MaxBlockSize), zstd.WithDecoderMaxMemory(MaxBlockSize),
				zstd.WithDecodeAllCapLimit(true))
			if err != nil {
				return fmt.Errorf("block %d decoder: %w", id, err)
			}
			slot.input = make([]byte, MaxBlockSize)
			slot.output = make([]byte, 0, MaxBlockSize)
		}
		copy(slot.input, f.payload[block.Offset:block.Offset+block.CompressedSize])
		decoded, err := slot.decoder.DecodeAll(slot.input[:block.CompressedSize], slot.output[:0])
		if err != nil {
			return fmt.Errorf("block %d: %w", id, err)
		}
		if int64(len(decoded)) != block.Size {
			return fmt.Errorf("block %d: invalid decoded size", id)
		}
		slot.output = decoded
		slot.blockID = id
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	copy(p, slot.output[offset:offset+int64(len(p))])
	return nil
}
