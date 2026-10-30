package pool

import (
	"context"
	"sync"
	"time"

	"go-telegram-bot/internal/resolver"
)

type Job struct {
	URL    string
	Result chan resolver.Result
}

type WorkerPool struct {
	workerCount int
	jobQueue    chan Job
	resolver    *resolver.Resolver
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

func New(workerCount int, queueBuffer int, r *resolver.Resolver) *WorkerPool {
	ctx, cancel := context.WithCancel(context.Background())
	p := &WorkerPool{
		workerCount: workerCount,
		jobQueue:    make(chan Job, queueBuffer),
		resolver:    r,
		ctx:         ctx,
		cancel:      cancel,
	}

	p.startWorkers()
	return p
}

func (p *WorkerPool) startWorkers() {
	for i := 0; i < p.workerCount; i++ {
		p.wg.Add(1)
		go p.worker(i + 1)
	}
}

func (p *WorkerPool) worker(id int) {
	defer p.wg.Done()
	for {
		select {
		case <-p.ctx.Done():
			return
		case job, ok := <-p.jobQueue:
			if !ok {
				return
			}
			res := p.resolver.Resolve(p.ctx, job.URL)
			job.Result <- res
		}
	}
}

// Submit enqueues a single URL and returns its result channel
func (p *WorkerPool) Submit(rawURL string) <-chan resolver.Result {
	resChan := make(chan resolver.Result, 1)
	p.jobQueue <- Job{
		URL:    rawURL,
		Result: resChan,
	}
	return resChan
}

// ResolveBatch processes multiple URLs concurrently in parallel goroutines
func (p *WorkerPool) ResolveBatch(urls []string) []resolver.Result {
	return p.ResolveBatchWithProgress(urls, nil)
}

type indexedResult struct {
	index int
	res   resolver.Result
}

// ResolveBatchWithProgress processes multiple URLs concurrently and reports progress in real-time
func (p *WorkerPool) ResolveBatchWithProgress(urls []string, onProgress func(res resolver.Result, done, total int)) []resolver.Result {
	count := len(urls)
	if count == 0 {
		return nil
	}

	results := make([]resolver.Result, count)
	outChan := make(chan indexedResult, count)

	// Submit all URLs smoothly to worker queue (spaced by 250ms so workers pick them up right away)
	go func() {
		for i, u := range urls {
			if i > 0 {
				time.Sleep(250 * time.Millisecond)
			}
			idx := i
			ch := p.Submit(u)
			go func(itemIdx int, itemChan <-chan resolver.Result) {
				r := <-itemChan
				outChan <- indexedResult{index: itemIdx, res: r}
			}(idx, ch)
		}
	}()

	completed := 0
	for completed < count {
		item := <-outChan
		results[item.index] = item.res
		completed++
		if onProgress != nil {
			onProgress(item.res, completed, count)
		}
	}

	return results
}

func (p *WorkerPool) Stop() {
	p.cancel()
	close(p.jobQueue)
	p.wg.Wait()
}
