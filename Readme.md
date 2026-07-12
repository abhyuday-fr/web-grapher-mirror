# Web Graph Visualizer.. web-grapher
The Web Graph Visualizer is a tool designed to map the internal structure of websites.
By entering a target URL, the application crawls the site and generates an interactive, force-directed graph.
This visualization helps users understand how pages within a domain are interconnected.

## Features
- **Automated Crawling**: The system systematically explores the internal links of a provided domain.
- **Interactive Visualization**: Built using D3.js, the graph allows users to drag, zoom, and explore nodes.
- **In-Memory Caching**: Results are cached to provide faster responses for frequently mapped sites.
- **Redis Integration**: For production deployments, the backend supports Redis to maintain cache persistence across server restarts.
- **Rate Limiting**: Built-in concurrency control protects the server and the target website from being overwhelmed by requests.
