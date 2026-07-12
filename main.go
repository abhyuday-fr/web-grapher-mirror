package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

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
		fmt.Println("✅ Redis enabled")
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

	rootURL := strings.TrimRight(req.URL, "/")
	redisKey := "graph:" + rootURL

	// 1. Declare the variable at the top level of this function
	export := GraphExport{
		Nodes: []Node{},
		Links: []Link{},
	}

	// Try Cache
	if useRedis {
		if val, err := rdb.Get(ctx, redisKey).Result(); err == nil {
			return c.SendString(val)
		}
	}

	// Rate Limiting
	crawlSemaphore <- struct{}{}
	defer func() { <-crawlSemaphore }()

	// --- [ ... Your Crawler Logic ... ] ---
	// Inside your crawler, populate 'export' like this:
	// export.Nodes = append(export.Nodes, newNode)
	// export.Links = append(export.Links, newLink)

	// Save to Redis
	if useRedis {
		jsonBytes, _ := json.Marshal(export)
		rdb.Set(ctx, redisKey, jsonBytes, 1*time.Hour)
	}

	// Now 'export' is defined and safe to return
	return c.JSON(export)
}
