// Initialize Icons
lucide.createIcons();

// --- Core Configuration ---
const colors = {
    root: '#38bdf8',    // Bright Sky Blue for Home Page
    public: '#f8fafc',  // Crisp White for public pages
    auth: '#475569'     // Dull Gray for restricted/auth pages
};

const sizes = {
    root: 14,
    standard: 6
};

// --- Graph Initialization ---
const container = document.getElementById('graph-container');
const width = container.clientWidth;
const height = container.clientHeight;

const svg = d3.select('#graph-container')
    .append('svg')
    .attr('width', width)
    .attr('height', height);

const g = svg.append('g'); // Group for zooming

// Setup Zoom & Pan
const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
        g.attr('transform', event.transform);
    });
svg.call(zoom);

// Add SVG defs for arrow markers
svg.append("defs").append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 18) // Distance from the center of the target node
    .attr("refY", 0)
    .attr("markerWidth", 5)
    .attr("markerHeight", 5)
    .attr("orient", "auto")
    .append("path")
    .attr("fill", "#64748b") // matches slate-500 link color
    .attr("d", "M0,-5L10,0L0,5");

// --- Load Data from Go Fiber API ---
async function loadGraph(targetUrl = null) {
    document.getElementById('stats').innerText = targetUrl ? `Crawling ${targetUrl} (This may take a few seconds)...` : "Enter a URL to begin mapping.";
    
    // Clear existing graph elements for new crawls
    g.selectAll('.links').remove();
    g.selectAll('.nodes').remove();
    
    let data;
    
    if (targetUrl) {
        try {
            // Fetch from our Go Fiber backend
            const response = await fetch('/api/crawl', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: targetUrl })
            });
            
            if (!response.ok) throw new Error('Crawl failed');
            data = await response.json();
            document.getElementById('stats').innerText = `Map complete.`;
        } catch (error) {
            console.error("Crawl error:", error);
            document.getElementById('stats').innerText = "Error crawling website. Make sure the Go server is running.";
            return;
        }
    } else {
        return; // Do nothing on initial load until user submits a URL
    }

    // Identify root node (usually the one with the shortest URL or explicitly marked)
    if (data.nodes.length > 0 && !data.nodes.find(n => n.isRoot)) {
        // Sort by length to find base domain
        const sortedNodes = [...data.nodes].sort((a,b) => a.id.length - b.id.length);
        const rootId = sortedNodes[0].id;
        data.nodes.forEach(n => {
            if(n.id === rootId) {
                n.isRoot = true;
                if (!n.title) n.title = `Home - ${new URL(rootId).hostname}`;
            }
        });
    }

    // --- CALCULATE DEPTH FOR BALLOON LAYOUT ---
    // 1. Initialize all depths to -1 (unvisited)
    data.nodes.forEach(n => n.depth = -1);
    
    // 2. Find the root and set depth to 0
    const rootNode = data.nodes.find(n => n.isRoot);
    if (rootNode) {
        rootNode.depth = 0;
        let queue = [rootNode];
        
        // 3. Breadth-First Search (BFS) to calculate distance from root
        while (queue.length > 0) {
            let current = queue.shift();
            
            // Find all links originating from the current node
            let outgoingLinks = data.links.filter(l => (l.source.id || l.source) === current.id);
            
            outgoingLinks.forEach(link => {
                let targetId = link.target.id || link.target;
                let targetNode = data.nodes.find(n => n.id === targetId);
                
                // If we haven't visited this node yet, assign depth and add to queue
                if (targetNode && targetNode.depth === -1) {
                    targetNode.depth = current.depth + 1;
                    queue.push(targetNode);
                }
            });
        }
    }
    // Nodes not connected to the root will remain at depth -1, we'll bump them to a default
    data.nodes.forEach(n => { if (n.depth === -1) n.depth = 4; });
    
    renderGraph(data.nodes, data.links);
}

function renderGraph(nodes, links) {
    // Update stats
    document.getElementById('stats').innerText = `${nodes.length} nodes, ${links.length} edges`;

    // Pre-calculate degrees (connections) for UI
    const degreeMap = {};
    nodes.forEach(n => degreeMap[n.id] = 0);
    links.forEach(l => {
        degreeMap[l.source.id || l.source] = (degreeMap[l.source.id || l.source] || 0) + 1;
        degreeMap[l.target.id || l.target] = (degreeMap[l.target.id || l.target] || 0) + 1;
    });
    nodes.forEach(n => n.connections = degreeMap[n.id]);

    // --- BALLOON FORCE SIMULATION ---
    const simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(120))
        .force('charge', d3.forceManyBody().strength(-600)) 
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(d => (height * 0.85) - (d.depth * 180)).strength(1))
        .force('collide', d3.forceCollide().radius(d => d.isRoot ? sizes.root + 25 : sizes.standard + 25));

    // Draw Links with marker-end for arrows
    const link = g.append('g')
        .attr('class', 'links')
        .selectAll('line')
        .data(links)
        .join('line')
        .attr('class', 'link')
        .attr('stroke-width', 1.5)
        .attr("marker-end", "url(#arrow)");

    // Draw Nodes
    const node = g.append('g')
        .attr('class', 'nodes')
        .selectAll('g')
        .data(nodes)
        .join('g')
        .attr('class', 'node')
        .call(drag(simulation));

    // Add Circles to Nodes
    node.append('circle')
        .attr('r', d => d.isRoot ? sizes.root : sizes.standard)
        .attr('fill', d => {
            if (d.isRoot) return colors.root;
            return d.group === 1 ? colors.public : colors.auth;
        })
        .attr('stroke', '#0f172a') // background color for border
        .attr('stroke-width', 1.5)
        .style('filter', d => d.isRoot || d.group === 1 ? 'drop-shadow(0 0 4px rgba(255,255,255,0.3))' : 'none');

    // --- Interactions ---

    let selectedNode = null;
    const tooltip = d3.select("#tooltip");

    // Hover effects for title tooltips
    node.on('mouseover', (event, d) => {
        tooltip.style("opacity", 1)
                .html(`<div class="font-bold text-sky-300">${d.title || 'Web Page'}</div><div class="text-xs text-slate-300 mt-1 truncate max-w-[250px]">${d.id}</div>`)
                .style("left", (event.pageX) + "px")
                .style("top", (event.pageY) + "px");
    });

    node.on('mousemove', (event) => {
        tooltip.style("left", (event.pageX) + "px")
                .style("top", (event.pageY) + "px");
    });

    node.on('mouseout', () => {
        tooltip.style("opacity", 0);
    });

    node.on('click', (event, d) => {
        // Highlight logic
        node.selectAll('circle').attr('stroke', '#0f172a').attr('stroke-width', 1.5);
        d3.select(event.currentTarget).select('circle').attr('stroke', '#38bdf8').attr('stroke-width', 3);
        selectedNode = d;
        openSidebar(d);
    });

    node.on('dblclick', (event, d) => {
        window.open(d.id, '_blank');
    });

    // Simulation Tick (Updates positions on every frame)
    simulation.on('tick', () => {
        link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

        node
            .attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // Zoom to fit initially
    svg.transition().duration(1000).call(
        zoom.transform, 
        d3.zoomIdentity.translate(width/2, height/2).scale(0.8).translate(-width/2, -height/2)
    );
}

// --- Dragging Physics Boilerplate ---
function drag(simulation) {
    function dragstarted(event) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
    }
    
    function dragged(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
    }
    
    function dragended(event) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
    }
    
    return d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
}

// --- UI Sidebar Logic ---
const sidebar = document.getElementById('sidebar');
const closeSidebarBtn = document.getElementById('close-sidebar');
const visitBtn = document.getElementById('visit-btn');
let currentUrl = '';

function openSidebar(data) {
    currentUrl = data.id;
    document.getElementById('node-url').textContent = data.id;
    document.getElementById('node-connections').textContent = `${data.connections} linked pages`;
    
    const statusDiv = document.getElementById('node-status');
    if (data.isRoot) {
        statusDiv.innerHTML = `<span class="w-2 h-2 rounded-full" style="background:${colors.root}"></span> Root Page`;
    } else if (data.group === 1) {
        statusDiv.innerHTML = `<span class="w-2 h-2 rounded-full" style="background:${colors.public}"></span> Public Access`;
    } else {
        statusDiv.innerHTML = `<span class="w-2 h-2 rounded-full" style="background:${colors.auth}"></span> Requires Auth / Restricted`;
    }

    // Slide in
    sidebar.classList.remove('translate-x-[120%]');
}

closeSidebarBtn.addEventListener('click', () => {
    sidebar.classList.add('translate-x-[120%]');
    // Remove highlight
    d3.selectAll('.node circle').attr('stroke', '#0f172a').attr('stroke-width', 1.5);
});

visitBtn.addEventListener('click', () => {
    if (currentUrl) window.open(currentUrl, '_blank');
});

// --- Web Based Form Submission ---
document.getElementById('crawl-form').addEventListener('submit', (e) => {
    e.preventDefault();
    let urlInput = document.getElementById('url-input').value.trim();
    
    // Auto-append https:// if missing
    if (!/^https?:\/\//i.test(urlInput)) {
        urlInput = 'https://' + urlInput;
        document.getElementById('url-input').value = urlInput;
    }
    
    const btn = document.getElementById('crawl-btn');
    const originalText = btn.innerHTML;
    
    // Loading state
    btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Mapping...';
    btn.disabled = true;

    // Trigger the actual API crawl request
    loadGraph(urlInput).then(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
        lucide.createIcons(); // re-initialize icons in the button
    });
});

// Load empty graph on startup
loadGraph();
