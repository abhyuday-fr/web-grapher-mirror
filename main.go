package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gocolly/colly/v2"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/redis/go-redis/v9"
)

// --- Structures ---
type Node struct {
	ID     string `json:"id"`
	Group  int    `json:"group"`
	Title  string `json:"title"`
	IsRoot bool   `json:"isRoot"`
}
type Link struct {
	Source string `json:"source"`
	Target string `json:"target"`
}
type GraphExport struct {
	Nodes []Node `json:"nodes"`
	Links []Link `json:"links"`
}

// Internal thread-safe state for an active crawl
type PageData struct {
	Group int
	Title string
}
type SafeGraph struct {
	mu         sync.Mutex
	Nodes      map[string]*PageData
	Edges      map[string]struct{}
	VisitCount int
	MaxVisits  int
}

var (
	crawlSemaphore = make(chan struct{}, 5) // Local Rate Limiting
	rdb            *redis.Client
	ctx            = context.Background()
	useRedis       bool
)

func main() {
	// Initialize Redis if URL exists
	if redisURL := os.Getenv("REDIS_URL"); redisURL != "" {
		opt, _ := redis.ParseURL(redisURL)
		rdb = redis.NewClient(opt)
		useRedis = true
		fmt.Println("Redis enabled")
	}

	app := fiber.New()
	app.Use(logger.New())
	app.Static("/", "./public")
	app.Post("/api/crawl", handleCrawl)

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Fatal(app.Listen(":" + port))
}

func handleCrawl(c *fiber.Ctx) error {
	var req struct {
		URL string `json:"url"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).SendString("Bad Request")
	}

	parsedURL, err := url.ParseRequestURI(req.URL)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid URL format"})
	}

	targetDomain := parsedURL.Host
	rootURL := strings.TrimRight(req.URL, "/")
	redisKey := "graph:" + rootURL

	// 1. Try Cache First
	if useRedis {
		if val, err := rdb.Get(ctx, redisKey).Result(); err == nil {
			return c.SendString(val) // Serve cached JSON directly
		}
	}

	// 2. Rate Limiting (Semaphore)
	crawlSemaphore <- struct{}{}
	defer func() { <-crawlSemaphore }()

	// 3. Initialize Graph State for the Crawler
	graph := &SafeGraph{
		Nodes:      make(map[string]*PageData),
		Edges:      make(map[string]struct{}),
		VisitCount: 0,
		MaxVisits:  100, // Limit pages to prevent timeouts/memory leaks
	}

	collector := colly.NewCollector(
		colly.AllowedDomains(targetDomain),
		colly.MaxDepth(3),
		colly.Async(true),
	)

	collector.Limit(&colly.LimitRule{
		DomainGlob:  "*",
		Parallelism: 20,
		RandomDelay: 50 * time.Millisecond,
	})

	// Extract Links
	collector.OnHTML("a[href]", func(e *colly.HTMLElement) {
		graph.mu.Lock()
		if graph.VisitCount >= graph.MaxVisits {
			graph.mu.Unlock()
			return
		}
		graph.mu.Unlock()

		link := e.Attr("href")
		absoluteURL := e.Request.AbsoluteURL(link)

		u, err := url.Parse(absoluteURL)
		if err != nil || u.Host != targetDomain {
			return
		}
		u.Fragment = ""
		cleanTarget := strings.TrimRight(u.String(), "/")
		cleanSource := strings.TrimRight(e.Request.URL.String(), "/")

		if cleanSource == cleanTarget {
			return
		}

		graph.mu.Lock()
		edgeKey := fmt.Sprintf("%s|%s", cleanSource, cleanTarget)
		graph.Edges[edgeKey] = struct{}{}

		isNewNode := false
		if _, exists := graph.Nodes[cleanTarget]; !exists {
			graph.Nodes[cleanTarget] = &PageData{Group: 1, Title: "Web Page"}
			graph.VisitCount++
			isNewNode = true
		}
		graph.mu.Unlock()

		if isNewNode {
			e.Request.Visit(cleanTarget)
		}
	})

	// Extract Titles
	collector.OnHTML("head title", func(e *colly.HTMLElement) {
		title := strings.TrimSpace(e.Text)
		cleanURL := strings.TrimRight(e.Request.URL.String(), "/")

		graph.mu.Lock()
		if node, exists := graph.Nodes[cleanURL]; exists {
			node.Title = title
		} else {
			graph.Nodes[cleanURL] = &PageData{Group: 1, Title: title}
		}
		graph.mu.Unlock()
	})

	// Check Auth/Status Codes
	collector.OnResponse(func(r *colly.Response) {
		cleanURL := strings.TrimRight(r.Request.URL.String(), "/")

		graph.mu.Lock()
		node, exists := graph.Nodes[cleanURL]
		if !exists {
			node = &PageData{Group: 1, Title: "Web Page"}
			graph.Nodes[cleanURL] = node
		}

		if r.StatusCode == 401 || r.StatusCode == 403 || strings.Contains(strings.ToLower(cleanURL), "login") {
			node.Group = 2
		}
		graph.mu.Unlock()
	})

	// Initialize the Root Node and Trigger Crawl
	graph.mu.Lock()
	graph.Nodes[rootURL] = &PageData{Group: 1, Title: "Loading..."}
	graph.VisitCount = 1
	graph.mu.Unlock()

	collector.Visit(rootURL)
	collector.Wait()

	// 4. Format Output for Frontend
	export := GraphExport{
		Nodes: []Node{},
		Links: []Link{},
	}
	for u, data := range graph.Nodes {
		export.Nodes = append(export.Nodes, Node{
			ID:     u,
			Group:  data.Group,
			Title:  data.Title,
			IsRoot: (u == rootURL),
		})
	}
	for edge := range graph.Edges {
		parts := strings.Split(edge, "|")
		if len(parts) == 2 {
			export.Links = append(export.Links, Link{Source: parts[0], Target: parts[1]})
		}
	}

	// 5. Save to Redis
	if useRedis {
		jsonBytes, _ := json.Marshal(export)
		rdb.Set(ctx, redisKey, jsonBytes, 1*time.Hour)
	}

	return c.JSON(export)
}
