package cache

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const (
	DeadLinkSentinel = "__DEAD_LINK__"
	DeadLinkTTL      = 15 * time.Minute
	ValidLinkTTL     = 24 * time.Hour
)

var ErrDeadLink = errors.New("link is dead or token not found (404)")

type Item struct {
	Destination string
	Title       string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	IsDead      bool
}

type MongoLinkDoc struct {
	OriginalURL string    `bson:"original_url,omitempty"`
	MediatorURL string    `bson:"mediatorUrl,omitempty"`
	ResolvedURL string    `bson:"resolved_url,omitempty"`
	ProviderURL string    `bson:"providerUrl,omitempty"`
	Title       string    `bson:"title,omitempty"`
	Filename    string    `bson:"filename,omitempty"`
	Status      string    `bson:"status,omitempty"`
	UpdatedAt   time.Time `bson:"updatedAt,omitempty"`
}

type MultiTierCache struct {
	l1Memory sync.Map // L1: < 0.01ms in-memory cache
	l2Redis  *redis.Client
	l3Mongo  *mongo.Collection
	hits     uint64
	misses   uint64
	deadHits uint64
}

// MemoryCache alias for seamless backward compatibility
type MemoryCache = MultiTierCache

func New(ttl time.Duration) *MultiTierCache {
	return &MultiTierCache{}
}

func NewMultiTierCache(rdb *redis.Client, mongoCol *mongo.Collection) *MultiTierCache {
	return &MultiTierCache{
		l2Redis: rdb,
		l3Mongo: mongoCol,
	}
}

// Get checks L1 (sync.Map) -> L2 (Upstash Redis) -> L3 (MongoDB) and backfills upper tiers.
func (c *MultiTierCache) Get(ctx context.Context, rawURL string) (string, bool, error) {
	if rawURL == "" {
		return "", false, nil
	}

	// 1. Check L1 (Go sync.Map) - < 0.01ms
	if val, ok := c.l1Memory.Load(rawURL); ok {
		if item, isItem := val.(Item); isItem {
			if item.IsDead || item.Destination == DeadLinkSentinel {
				if time.Now().Before(item.ExpiresAt) {
					atomic.AddUint64(&c.hits, 1)
					atomic.AddUint64(&c.deadHits, 1)
					return "", true, ErrDeadLink
				}
				c.l1Memory.Delete(rawURL)
			} else {
				if item.ExpiresAt.IsZero() || time.Now().Before(item.ExpiresAt) {
					atomic.AddUint64(&c.hits, 1)
					return item.Destination, true, nil
				}
				c.l1Memory.Delete(rawURL)
			}
		} else if strVal, isStr := val.(string); isStr {
			if strVal == DeadLinkSentinel {
				atomic.AddUint64(&c.hits, 1)
				atomic.AddUint64(&c.deadHits, 1)
				return "", true, ErrDeadLink
			}
			atomic.AddUint64(&c.hits, 1)
			return strVal, true, nil
		}
	}

	// 2. Check L2 (Upstash Redis) - ~5-15ms
	if c.l2Redis != nil {
		rCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if redisVal, err := c.l2Redis.Get(rCtx, "linkscrap:"+rawURL).Result(); err == nil && redisVal != "" {
			c.l1Memory.Store(rawURL, Item{
				Destination: redisVal,
				CreatedAt:   time.Now(),
				ExpiresAt:   time.Now().Add(ValidLinkTTL),
				IsDead:      redisVal == DeadLinkSentinel,
			})
			atomic.AddUint64(&c.hits, 1)
			if redisVal == DeadLinkSentinel {
				atomic.AddUint64(&c.deadHits, 1)
				return "", true, ErrDeadLink
			}
			return redisVal, true, nil
		}
	}

	// 3. Check L3 (MongoDB Atlas) - ~30-60ms
	if c.l3Mongo != nil {
		mCtx, mCancel := context.WithTimeout(ctx, 4*time.Second)
		defer mCancel()
		var doc MongoLinkDoc
		filter := bson.M{
			"$or": []bson.M{
				{"mediatorUrl": rawURL},
				{"original_url": rawURL},
			},
		}
		err := c.l3Mongo.FindOne(mCtx, filter).Decode(&doc)
		resolved := doc.ResolvedURL
		if resolved == "" {
			resolved = doc.ProviderURL
		}
		if err == nil && resolved != "" {
			// Backfill L1 and L2 asynchronously so the current request returns immediately
			c.l1Memory.Store(rawURL, Item{
				Destination: resolved,
				Title:       doc.Title,
				CreatedAt:   time.Now(),
				ExpiresAt:   time.Now().Add(ValidLinkTTL),
			})
			if c.l2Redis != nil {
				go func(u, res string) {
					bgCtx, bCancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer bCancel()
					_ = c.l2Redis.Set(bgCtx, "linkscrap:"+u, res, ValidLinkTTL).Err()
				}(rawURL, resolved)
			}
			atomic.AddUint64(&c.hits, 1)
			return resolved, true, nil
		}
	}

	atomic.AddUint64(&c.misses, 1)
	return "", false, nil
}

// SetValid stores a resolved link across all 3 tiers (L1, L2, L3).
func (c *MultiTierCache) SetValid(ctx context.Context, rawURL, resolvedURL string) {
	if rawURL == "" || resolvedURL == "" {
		return
	}
	c.l1Memory.Store(rawURL, Item{
		Destination: resolvedURL,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(ValidLinkTTL),
	})

	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Save to L2 (Redis)
		if c.l2Redis != nil {
			_ = c.l2Redis.Set(bgCtx, "linkscrap:"+rawURL, resolvedURL, ValidLinkTTL).Err()
		}

		// Upsert to L3 (MongoDB)
		if c.l3Mongo != nil {
			filter := bson.M{
				"$or": []bson.M{
					{"mediatorUrl": rawURL},
					{"original_url": rawURL},
				},
			}
			update := bson.M{
				"$set": bson.M{
					"original_url": rawURL,
					"mediatorUrl":  rawURL,
					"resolved_url": resolvedURL,
					"providerUrl":  resolvedURL,
					"status":       "RESOLVED",
					"updatedAt":    time.Now(),
				},
			}
			opts := options.Update().SetUpsert(true)
			_, _ = c.l3Mongo.UpdateOne(bgCtx, filter, update, opts)
		}
	}()
}

// SetDead caches a 404/invalid token in L1 and L2 so workers never re-run it.
func (c *MultiTierCache) SetDead(rawURL string) {
	if rawURL == "" {
		return
	}
	c.l1Memory.Store(rawURL, Item{
		Destination: DeadLinkSentinel,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(DeadLinkTTL),
		IsDead:      true,
	})
	if c.l2Redis != nil {
		go func() {
			bgCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = c.l2Redis.Set(bgCtx, "linkscrap:"+rawURL, DeadLinkSentinel, DeadLinkTTL).Err()
		}()
	}
}

// Backward-compatible methods
func (c *MultiTierCache) Set(key, destination, title string) {
	c.SetValid(context.Background(), key, destination)
}

func (c *MultiTierCache) Stats() (total int, hits uint64, misses uint64) {
	count := 0
	c.l1Memory.Range(func(_, _ interface{}) bool {
		count++
		return true
	})
	return count, atomic.LoadUint64(&c.hits), atomic.LoadUint64(&c.misses)
}
