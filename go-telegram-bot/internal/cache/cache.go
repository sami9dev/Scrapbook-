package cache

import (
	"sync"
	"time"
)

type Item struct {
	Destination string
	Title       string
	CreatedAt   time.Time
	ExpiresAt   time.Time
}

type MemoryCache struct {
	mu    sync.RWMutex
	items map[string]Item
	ttl   time.Duration
	hits  uint64
	misses uint64
}

func New(ttl time.Duration) *MemoryCache {
	c := &MemoryCache{
		items: make(map[string]Item),
		ttl:   ttl,
	}
	// Background cleanup of expired items every 10 minutes
	go c.startCleanupWorker(10 * time.Minute)
	return c
}

func (c *MemoryCache) Get(key string) (Item, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	item, exists := c.items[key]
	if !exists {
		c.misses++
		return Item{}, false
	}

	if c.ttl > 0 && time.Now().After(item.ExpiresAt) {
		c.misses++
		return Item{}, false
	}

	c.hits++
	return item, true
}

func (c *MemoryCache) Set(key, destination, title string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	expires := time.Time{}
	if c.ttl > 0 {
		expires = time.Now().Add(c.ttl)
	}

	c.items[key] = Item{
		Destination: destination,
		Title:       title,
		CreatedAt:   time.Now(),
		ExpiresAt:   expires,
	}
}

func (c *MemoryCache) Stats() (total int, hits uint64, misses uint64) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.items), c.hits, c.misses
}

func (c *MemoryCache) startCleanupWorker(interval time.Duration) {
	ticker := time.NewTicker(interval)
	for range ticker.C {
		if c.ttl == 0 {
			continue
		}
		c.mu.Lock()
		now := time.Now()
		for k, v := range c.items {
			if now.After(v.ExpiresAt) {
				delete(c.items, k)
			}
		}
		c.mu.Unlock()
	}
}
