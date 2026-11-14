package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"io"
	"net/http"
	"strings"
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
	maxL1Entries     = 2048
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
	l1Memory     sync.Map // L1: < 0.01ms in-memory cache
	l1Mu         sync.Mutex
	l1Count      int
	l2Redis      *redis.Client
	l2RESTURL    string
	l2RESTToken  string
	l2RESTClient *http.Client
	l3Mongo      *mongo.Collection
	hits         uint64
	misses       uint64
	deadHits     uint64
}

// storeL1 bounds process-local cache growth. The shared Redis cache remains the
// source for entries evicted from this fast, per-process tier.
func (c *MultiTierCache) storeL1(key string, value interface{}) {
	c.l1Mu.Lock()
	defer c.l1Mu.Unlock()

	if _, exists := c.l1Memory.Load(key); !exists {
		if c.l1Count >= maxL1Entries {
			c.l1Memory.Range(func(evictKey, _ interface{}) bool {
				if evictKey == key {
					return true
				}
				c.l1Memory.Delete(evictKey)
				c.l1Count--
				return false
			})
		}
		c.l1Count++
	}
	c.l1Memory.Store(key, value)
}

func (c *MultiTierCache) deleteL1(key string, expected interface{}) {
	c.l1Mu.Lock()
	defer c.l1Mu.Unlock()
	if current, exists := c.l1Memory.Load(key); exists && current == expected {
		c.l1Memory.Delete(key)
		c.l1Count--
	}
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

// NewMultiTierCacheWithREST supports the Upstash REST credentials used by the
// Render service while preserving the Redis TCP client for local deployments.
func NewMultiTierCacheWithREST(rdb *redis.Client, mongoCol *mongo.Collection, restURL, restToken string) *MultiTierCache {
	c := NewMultiTierCache(rdb, mongoCol)
	c.l2RESTURL = strings.TrimRight(restURL, "/")
	c.l2RESTToken = restToken
	c.l2RESTClient = &http.Client{
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			MaxIdleConns:        20,
			MaxIdleConnsPerHost: 10,
			IdleConnTimeout:     90 * time.Second,
		},
	}
	return c
}

func (c *MultiTierCache) hasL2() bool {
	return c.l2Redis != nil || (c.l2RESTURL != "" && c.l2RESTToken != "")
}

func (c *MultiTierCache) l2Key(rawURL string) string {
	if c.l2Redis != nil {
		return "linkscrap:" + rawURL
	}
	keyHash := sha256.Sum256([]byte(strings.TrimSpace(rawURL)))
	return "cinefuel:cache:link:" + hex.EncodeToString(keyHash[:])
}

func (c *MultiTierCache) getL2(ctx context.Context, rawURL string) (string, error) {
	key := c.l2Key(rawURL)
	if c.l2Redis != nil {
		return c.l2Redis.Get(ctx, key).Result()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.l2RESTURL+"/get/"+key, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.l2RESTToken)
	resp, err := c.l2RESTClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, resp.Body)
		return "", fmt.Errorf("Upstash REST GET returned HTTP %d", resp.StatusCode)
	}
	var payload struct {
		Result *string `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	if payload.Result == nil {
		return "", redis.Nil
	}
	cleanVal := strings.Trim(strings.TrimSpace(*payload.Result), "\"' \t\r\n")
	return cleanVal, nil
}

func (c *MultiTierCache) setL2(ctx context.Context, rawURL, value string, ttl time.Duration) error {
	key := c.l2Key(rawURL)
	cleanVal := strings.Trim(strings.TrimSpace(value), "\"' \t\r\n")
	if c.l2Redis != nil {
		return c.l2Redis.Set(ctx, key, cleanVal, ttl).Err()
	}

	ttlSeconds := int64(ttl / time.Second)
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/set/%s?ex=%d", c.l2RESTURL, key, ttlSeconds), strings.NewReader(cleanVal))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.l2RESTToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.l2RESTClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("Upstash REST SET returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// GetL1 checks strictly the in-memory sync.Map tier (< 0.01ms), avoiding remote network calls.
func (c *MultiTierCache) GetL1(rawURL string) (string, bool, error) {
	if rawURL == "" {
		return "", false, nil
	}
	if val, ok := c.l1Memory.Load(rawURL); ok {
		if item, isItem := val.(Item); isItem {
			if item.IsDead || item.Destination == DeadLinkSentinel {
				if time.Now().Before(item.ExpiresAt) {
					atomic.AddUint64(&c.hits, 1)
					atomic.AddUint64(&c.deadHits, 1)
					return "", true, ErrDeadLink
				}
				c.deleteL1(rawURL, val)
			} else {
				if item.ExpiresAt.IsZero() || time.Now().Before(item.ExpiresAt) {
					atomic.AddUint64(&c.hits, 1)
					return item.Destination, true, nil
				}
				c.deleteL1(rawURL, val)
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
	return "", false, nil
}

// Get checks L1 (sync.Map) -> L2 (Upstash Redis) -> L3 (MongoDB) and backfills upper tiers.
func (c *MultiTierCache) Get(ctx context.Context, rawURL string) (string, bool, error) {
	if rawURL == "" {
		return "", false, nil
	}
	start := time.Now()

	// 1. Check L1 (Go sync.Map) - < 0.01ms
	if val, ok := c.l1Memory.Load(rawURL); ok {
		if item, isItem := val.(Item); isItem {
			if item.IsDead || item.Destination == DeadLinkSentinel {
				if time.Now().Before(item.ExpiresAt) {
					atomic.AddUint64(&c.hits, 1)
					atomic.AddUint64(&c.deadHits, 1)
					log.Printf("[TIMING] cache-lookup tier=L1 url=%s hit=true dead=true took=%v", rawURL, time.Since(start))
					return "", true, ErrDeadLink
				}
				c.deleteL1(rawURL, val)
			} else {
				if item.ExpiresAt.IsZero() || time.Now().Before(item.ExpiresAt) {
					atomic.AddUint64(&c.hits, 1)
					log.Printf("[TIMING] cache-lookup tier=L1 url=%s hit=true took=%v", rawURL, time.Since(start))
					return item.Destination, true, nil
				}
				c.deleteL1(rawURL, val)
			}
		} else if strVal, isStr := val.(string); isStr {
			if strVal == DeadLinkSentinel {
				atomic.AddUint64(&c.hits, 1)
				atomic.AddUint64(&c.deadHits, 1)
				log.Printf("[TIMING] cache-lookup tier=L1 url=%s hit=true dead=true took=%v", rawURL, time.Since(start))
				return "", true, ErrDeadLink
			}
			atomic.AddUint64(&c.hits, 1)
			log.Printf("[TIMING] cache-lookup tier=L1 url=%s hit=true took=%v", rawURL, time.Since(start))
			return strVal, true, nil
		}
	}

	// 2. Check L2 (Upstash Redis) - ~5-15ms
	if c.hasL2() {
		rCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if redisVal, err := c.getL2(rCtx, rawURL); err == nil && redisVal != "" {
			ttl := ValidLinkTTL
			if redisVal == DeadLinkSentinel {
				ttl = DeadLinkTTL
			}
			c.storeL1(rawURL, Item{
				Destination: redisVal,
				CreatedAt:   time.Now(),
				ExpiresAt:   time.Now().Add(ttl),
				IsDead:      redisVal == DeadLinkSentinel,
			})
			atomic.AddUint64(&c.hits, 1)
			if redisVal == DeadLinkSentinel {
				atomic.AddUint64(&c.deadHits, 1)
				log.Printf("[TIMING] cache-lookup tier=L2 url=%s hit=true dead=true took=%v", rawURL, time.Since(start))
				return "", true, ErrDeadLink
			}
			log.Printf("[TIMING] cache-lookup tier=L2 url=%s hit=true took=%v", rawURL, time.Since(start))
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
			c.storeL1(rawURL, Item{
				Destination: resolved,
				Title:       doc.Title,
				CreatedAt:   time.Now(),
				ExpiresAt:   time.Now().Add(ValidLinkTTL),
			})
			if c.hasL2() {
				go func(u, res string) {
					bgCtx, bCancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer bCancel()
					_ = c.setL2(bgCtx, u, res, ValidLinkTTL)
				}(rawURL, resolved)
			}
			atomic.AddUint64(&c.hits, 1)
			log.Printf("[TIMING] cache-lookup tier=L3 url=%s hit=true took=%v", rawURL, time.Since(start))
			return resolved, true, nil
		}
	}

	atomic.AddUint64(&c.misses, 1)
	log.Printf("[TIMING] cache-lookup tier=miss url=%s hit=false took=%v", rawURL, time.Since(start))
	return "", false, nil
}

// SetValid stores a resolved link across all 3 tiers (L1, L2, L3).
func (c *MultiTierCache) SetValid(ctx context.Context, rawURL, resolvedURL string) {
	if rawURL == "" || resolvedURL == "" {
		return
	}
	c.storeL1(rawURL, Item{
		Destination: resolvedURL,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(ValidLinkTTL),
	})

	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Save to L2 (Redis)
		if c.hasL2() {
			_ = c.setL2(bgCtx, rawURL, resolvedURL, ValidLinkTTL)
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
	c.storeL1(rawURL, Item{
		Destination: DeadLinkSentinel,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(DeadLinkTTL),
		IsDead:      true,
	})
	if c.hasL2() {
		go func() {
			bgCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = c.setL2(bgCtx, rawURL, DeadLinkSentinel, DeadLinkTTL)
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
