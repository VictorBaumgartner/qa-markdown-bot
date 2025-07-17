const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');
const express = require('express');
const fetch = require('node-fetch').default;
const swaggerUi = require('swagger-ui-express');
const cliProgress = require('cli-progress');
const cluster = require('cluster');
const os = require('os');

// --- CONFIGURATION ---
const CONFIG = {
    network_share_path: "/Users/Shared/CrawledData",
    model_context_tokens: 8192,
    ollama_url: "http://localhost:11434",
    model_name: "llama3.1:8b",
    max_response_length: 500,
    max_concurrent_requests: 10, // Limit concurrent Ollama requests
    cache_ttl: 3600000, // 1 hour cache TTL
    chunk_size: 4000, // Max chars per context chunk
    use_clustering: false // Set to true for multi-core processing
};

// --- ENHANCED CACHE WITH TTL ---
class TTLCache {
    constructor(ttl = CONFIG.cache_ttl) {
        this.cache = new Map();
        this.ttl = ttl;
    }

    set(key, value) {
        const expiry = Date.now() + this.ttl;
        this.cache.set(key, { value, expiry });
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }
        
        return item.value;
    }

    has(key) {
        return this.get(key) !== null;
    }

    clear() {
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }
}

// --- CACHES ---
const markdownCache = new TTLCache();
const responseCache = new TTLCache(1800000); // 30 min for responses

// --- CONCURRENCY CONTROL ---
class ConcurrencyController {
    constructor(maxConcurrent = CONFIG.max_concurrent_requests) {
        this.maxConcurrent = maxConcurrent;
        this.running = 0;
        this.queue = [];
    }

    async execute(asyncFn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn: asyncFn, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.running >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        this.running++;
        const { fn, resolve, reject } = this.queue.shift();

        try {
            const result = await fn();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            this.running--;
            this.processQueue();
        }
    }
}

const concurrencyController = new ConcurrencyController();

// --- EXPRESS APP SETUP ---
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Add compression middleware
const compression = require('compression');
app.use(compression());

// Add request timeout
const timeout = require('connect-timeout');
app.use(timeout('300s')); // 5 minute timeout

const PORT = process.env.PORT || 3000;

// --- ENHANCED API DOCUMENTATION ---
const openApiSpec = {
    openapi: "3.0.3",
    info: {
        title: "High-Performance Q&A API",
        version: "7.0.0",
        description: "An optimized API with intelligent caching, concurrency control, and enhanced performance."
    },
    servers: [{ url: `http://localhost:${PORT}` }],
    paths: {
        "/process-single-question": {
            post: {
                summary: "Process a single question with caching",
                description: "Submits one question and returns a precise answer using cached markdown content with response caching.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    folder_name: { type: "string", example: "crawl_zadkine_paris_fr_1752142903921" },
                                    single_question: { type: "string", example: "Quelles sont les expositions actuelles ?" },
                                    use_cache: { type: "boolean", default: true, description: "Whether to use response caching" }
                                },
                                required: ["folder_name", "single_question"]
                            }
                        }
                    }
                },
                responses: { 
                    "200": { 
                        description: "Success",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        folder: { type: "string" },
                                        question: { type: "string" },
                                        reponse: { type: "string" },
                                        found: { type: "boolean", description: "True if relevant answer found in documentation" },
                                        cached: { type: "boolean" },
                                        timestamp: { type: "string" }
                                    }
                                }
                            }
                        }
                    }, 
                    "400": { description: "Bad Request" }, 
                    "404": { description: "Not Found" }, 
                    "500": { description: "Server Error" },
                    "503": { description: "Service Unavailable" }
                }
            }
        },
        "/process-csv": {
            post: {
                summary: "Process a CSV file with batch optimization",
                description: "Processes CSV questions in optimized batches with progress tracking.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    folder_name: { type: "string", example: "crawl_zadkine_paris_fr_1752142903921" },
                                    csv_path: { type: "string", example: "/Users/victor/Desktop/questions.csv" },
                                    batch_size: { type: "number", default: 5, description: "Number of questions to process simultaneously" }
                                },
                                required: ["folder_name", "csv_path"]
                            }
                        }
                    }
                },
                responses: { 
                    "200": { 
                        description: "Success",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        folder: { type: "string" },
                                        csv_path: { type: "string" },
                                        results: {
                                            type: "array",
                                            items: {
                                                type: "object",
                                                properties: {
                                                    question: { type: "string" },
                                                    reponse: { type: "string" },
                                                    found: { type: "boolean", description: "True if relevant answer found in documentation" },
                                                    cached: { type: "boolean" }
                                                }
                                            }
                                        },
                                        statistics: {
                                            type: "object",
                                            properties: {
                                                total_questions: { type: "number" },
                                                processed_questions: { type: "number" },
                                                cache_hits: { type: "number" },
                                                found_answers: { type: "number" },
                                                processing_time_seconds: { type: "number" },
                                                timestamp: { type: "string" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }, 
                    "400": { description: "Bad Request" }, 
                    "404": { description: "Not Found" }, 
                    "500": { description: "Server Error" }
                }
            }
        },
        "/health": {
            get: {
                summary: "Health check endpoint",
                description: "Returns server health status and cache statistics.",
                responses: {
                    "200": { description: "Server is healthy" }
                }
            }
        },
        "/cache/clear": {
            post: {
                summary: "Clear all caches",
                description: "Clears both markdown and response caches.",
                responses: {
                    "200": { description: "Caches cleared successfully" }
                }
            }
        }
    }
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get('/', (req, res) => res.redirect('/api-docs'));

// --- UTILITY FUNCTIONS ---
function chunkText(text, maxChars = CONFIG.chunk_size) {
    if (text.length <= maxChars) return [text];
    
    const chunks = [];
    let start = 0;
    
    while (start < text.length) {
        let end = start + maxChars;
        
        if (end < text.length) {
            // Try to break at a sentence or paragraph boundary
            const lastPeriod = text.lastIndexOf('.', end);
            const lastNewline = text.lastIndexOf('\n', end);
            const breakPoint = Math.max(lastPeriod, lastNewline);
            
            if (breakPoint > start + maxChars * 0.5) {
                end = breakPoint + 1;
            }
        }
        
        chunks.push(text.substring(start, end));
        start = end;
    }
    
    return chunks;
}

function sanitizeInput(input) {
    return input.trim().replace(/[^\w\s\-_.àâäéèêëïîôöùûüÿç]/gi, '');
}

function createCacheKey(folder, question) {
    return `${folder}:${Buffer.from(question).toString('base64')}`;
}

// --- CORE LOGIC FUNCTIONS ---
async function readMarkdownFiles(dir) {
    const resolvedDir = path.resolve(dir);
    
    try {
        await fs.access(resolvedDir);
    } catch (error) {
        const err = new Error(`Directory not found: ${resolvedDir}`);
        err.statusCode = 404;
        throw err;
    }

    let content = '';
    const files = await fs.readdir(resolvedDir, { withFileTypes: true });
    
    // Process files in parallel for better performance
    const filePromises = files.map(async (file) => {
        const fullPath = path.join(resolvedDir, file.name);
        
        if (file.isDirectory()) {
            return await readMarkdownFiles(fullPath);
        } else if (file.name.endsWith('.md')) {
            try {
                const fileContent = await fs.readFile(fullPath, 'utf8');
                // Enhanced relevance filtering
                const relevantKeywords = ['exposition', 'exhibition', 'musée', 'museum', 'art', 'collection', 'visite', 'horaire', 'tarif'];
                const hasRelevantContent = relevantKeywords.some(keyword => 
                    fileContent.toLowerCase().includes(keyword)
                );
                
                if (hasRelevantContent) {
                    return `\n\n--- Contenu du fichier: ${file.name} ---\n\n${fileContent}`;
                }
            } catch (error) {
                console.warn(`Warning: Could not read file ${fullPath}: ${error.message}`);
            }
        }
        return '';
    });

    const results = await Promise.all(filePromises);
    content = results.join('');
    
    return content;
}

async function loadMarkdownCache() {
    console.log("Pre-loading markdown content into cache...");
    
    try {
        const folders = await fs.readdir(CONFIG.network_share_path, { withFileTypes: true });
        const cachePromises = folders
            .filter(folder => folder.isDirectory())
            .map(async (folder) => {
                const folderPath = path.join(CONFIG.network_share_path, folder.name);
                try {
                    const content = await readMarkdownFiles(folderPath);
                    if (content.trim()) {
                        markdownCache.set(folder.name, content);
                        console.log(`✓ Cached markdown content for folder: ${folder.name} (${Math.round(content.length/1024)}KB)`);
                    }
                } catch (error) {
                    console.error(`✗ Failed to cache folder ${folder.name}: ${error.message}`);
                }
            });

        await Promise.all(cachePromises);
        console.log(`Markdown cache loading completed. ${markdownCache.size()} folders cached.`);
    } catch (error) {
        console.error(`Error loading markdown cache: ${error.message}`);
    }
}

async function getCachedMarkdown(folder_name) {
    if (!markdownCache.has(folder_name)) {
        console.log(`Loading markdown content for folder: ${folder_name}`);
        const folderPath = path.join(CONFIG.network_share_path, folder_name);
        const content = await readMarkdownFiles(folderPath);
        markdownCache.set(folder_name, content);
        console.log(`✓ Cached markdown content for folder: ${folder_name}`);
    }
    return markdownCache.get(folder_name);
}

async function parseCsvQuestions(csvPath) {
    try {
        await fs.access(csvPath);
    } catch (error) {
        const err = new Error(`CSV file not found: ${csvPath}`);
        err.statusCode = 404;
        throw err;
    }

    const csvContent = await fs.readFile(csvPath, 'utf8');
    
    try {
        const questions = parse(csvContent, { 
            columns: true, 
            skip_empty_lines: true, 
            trim: true,
            relax_column_count: true 
        });
        
        // Validate and filter questions
        return questions.filter(q => q.question && q.question.trim().length > 0);
    } catch (error) {
        const userError = new Error("Failed to parse CSV. Ensure 'question' header exists and CSV is properly formatted.");
        userError.statusCode = 400;
        throw userError;
    }
}

async function getAnswerFromOllama(question, context) {
    const today = new Date().toLocaleDateString('fr-FR', { 
        day: 'numeric', 
        month: 'long', 
        year: 'numeric' 
    });

    // Optimize context by chunking if too large
    const chunks = chunkText(context);
    let bestAnswer = null;
    let bestScore = 0;
    let foundRelevantInfo = false;

    for (const chunk of chunks.slice(0, 3)) { // Process max 3 chunks for speed
        const prompt = `Tu es un assistant expert pour un musée. Ta seule source de connaissance est le CONTEXTE ci-dessous. Réponds à la QUESTION de manière claire, concise et précise, en moins de ${CONFIG.max_response_length} caractères. Utilise uniquement les informations du CONTEXTE. N'invente RIEN. La date d'aujourd'hui est le ${today}. Si la réponse ne se trouve pas dans le CONTEXTE, réponds exactement: "Je ne trouve pas d'information pertinente dans les documents fournis pour répondre à cette question."\n\nCONTEXTE:\n${chunk}\n\nQUESTION:\n${question}\n\nRÉPONSE COURTOISE ET PRÉCISE:`;

        const payload = {
            model: CONFIG.model_name,
            prompt,
            stream: false,
            options: { 
                num_ctx: CONFIG.model_context_tokens,
                temperature: 0.1,
                top_p: 0.9,
                repeat_penalty: 1.1
            }
        };

        try {
            const response = await fetch(`${CONFIG.ollama_url}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                timeout: 30000 // 30 second timeout
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Ollama API Error: ${response.status} - ${errorBody}`);
            }

            const result = await response.json();
            let answer = result.response ? result.response.trim() : "La réponse du modèle était vide.";

            // Check if answer contains relevant information
            const isRelevantAnswer = !answer.includes("Je ne trouve pas d'information pertinente") && 
                                   !answer.includes("La réponse du modèle était vide") &&
                                   answer.length > 10; // Minimum meaningful response length

            // Score answer based on relevance
            const score = calculateRelevanceScore(answer, question);
            
            if (score > bestScore && isRelevantAnswer) {
                bestAnswer = answer;
                bestScore = score;
                foundRelevantInfo = true;
            }
        } catch (error) {
            if (error.message.includes("allocate") || error.message.includes("context window")) {
                throw new Error(`Ollama Memory Error: Reduce context size or restart Ollama.`);
            }
            console.warn(`Chunk processing failed: ${error.message}`);
            continue;
        }
    }

    const finalAnswer = bestAnswer || "Je ne trouve pas d'information pertinente dans les documents fournis pour répondre à cette question.";
    
    return {
        answer: finalAnswer,
        found: foundRelevantInfo
    };
}

function calculateRelevanceScore(answer, question) {
    const answerLower = answer.toLowerCase();
    const questionLower = question.toLowerCase();
    
    // Basic keyword matching
    const questionWords = questionLower.split(/\s+/).filter(w => w.length > 3);
    const matchCount = questionWords.filter(word => answerLower.includes(word)).length;
    
    // Length penalty for too short answers
    const lengthScore = Math.min(answer.length / 50, 1);
    
    return (matchCount / questionWords.length) * lengthScore;
}

// --- ENHANCED ENDPOINTS ---
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        cache: {
            markdown: markdownCache.size(),
            responses: responseCache.size()
        },
        config: {
            max_concurrent: CONFIG.max_concurrent_requests,
            model: CONFIG.model_name
        }
    });
});

app.post('/cache/clear', (req, res) => {
    markdownCache.clear();
    responseCache.clear();
    res.json({ message: 'All caches cleared successfully' });
});

app.post('/process-single-question', async (req, res) => {
    const { folder_name, single_question, use_cache = true } = req.body;
    
    if (!folder_name || !single_question) {
        return res.status(400).json({ 
            error: "Bad Request: 'folder_name' and 'single_question' are required." 
        });
    }

    const sanitizedQuestion = sanitizeInput(single_question);
    const cacheKey = createCacheKey(folder_name, sanitizedQuestion);

    console.log(`\n--- Single Question Request ---`);
    console.log(`Folder: ${folder_name}`);
    console.log(`Question: ${sanitizedQuestion}`);

    try {
        // Check response cache first
        if (use_cache && responseCache.has(cacheKey)) {
            console.log('✓ Cache hit for response');
            const cachedResponse = responseCache.get(cacheKey);
            return res.status(200).json({
                ...cachedResponse,
                cached: true,
                timestamp: new Date().toISOString()
            });
        }

        const markdownContent = await getCachedMarkdown(folder_name);
        
        if (!markdownContent || markdownContent.trim().length === 0) {
            return res.status(404).json({ 
                error: "No relevant content found for this folder." 
            });
        }

        const result = await concurrencyController.execute(async () => {
            return await getAnswerFromOllama(sanitizedQuestion, markdownContent);
        });

        const response = {
            folder: folder_name,
            question: sanitizedQuestion,
            reponse: result.answer,
            found: result.found,
            cached: false,
            timestamp: new Date().toISOString()
        };

        // Cache the response
        if (use_cache) {
            responseCache.set(cacheKey, response);
        }

        res.status(200).json(response);

    } catch (error) {
        console.error('Error processing single question:', error);
        res.status(error.statusCode || 500).json({ 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/process-csv', async (req, res) => {
    const { folder_name, csv_path, batch_size = 5 } = req.body;
    
    if (!folder_name || !csv_path) {
        return res.status(400).json({ 
            error: "Bad Request: 'folder_name' and 'csv_path' are required." 
        });
    }

    console.log(`\n--- CSV Processing Request ---`);
    console.log(`Folder: ${folder_name}`);
    console.log(`CSV Path: ${csv_path}`);
    console.log(`Batch Size: ${batch_size}`);

    try {
        const markdownContent = await getCachedMarkdown(folder_name);
        
        if (!markdownContent || markdownContent.trim().length === 0) {
            return res.status(404).json({ 
                error: "No relevant content found for this folder." 
            });
        }

        const questionsToProcess = await parseCsvQuestions(csv_path);
        console.log(`Found ${questionsToProcess.length} questions to process`);

        if (questionsToProcess.length === 0) {
            return res.status(400).json({ 
                error: "No valid questions found in CSV file." 
            });
        }

        const progressBar = new cliProgress.SingleBar({
            format: 'Processing |{bar}| {percentage}% | {value}/{total} | ETA: {eta}s',
            hideCursor: true
        }, cliProgress.Presets.shades_classic);

        progressBar.start(questionsToProcess.length, 0);
        
        const results = [];
        const startTime = Date.now();

        for (let i = 0; i < questionsToProcess.length; i += batch_size) {
            const batch = questionsToProcess.slice(i, i + batch_size);
            
            const batchPromises = batch.map(async (q) => {
                if (!q.question || q.question.trim().length === 0) {
                    return null;
                }

                const sanitizedQuestion = sanitizeInput(q.question);
                const cacheKey = createCacheKey(folder_name, sanitizedQuestion);

                try {
                    if (responseCache.has(cacheKey)) {
                        const cachedResponse = responseCache.get(cacheKey);
                        return {
                            question: sanitizedQuestion,
                            reponse: cachedResponse.reponse,
                            found: cachedResponse.found || false,
                            cached: true
                        };
                    }

                    const result = await concurrencyController.execute(async () => {
                        return await getAnswerFromOllama(sanitizedQuestion, markdownContent);
                    });

                    const response = {
                        question: sanitizedQuestion,
                        reponse: result.answer,
                        found: result.found,
                        cached: false
                    };

                    responseCache.set(cacheKey, {
                        folder: folder_name,
                        question: sanitizedQuestion,
                        reponse: result.answer,
                        found: result.found
                    });

                    return response;

                } catch (error) {
                    console.error(`\nError processing question "${sanitizedQuestion}": ${error.message}`);
                    return {
                        question: sanitizedQuestion,
                        reponse: `ERREUR: ${error.message}`,
                        found: false,
                        cached: false
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults.filter(r => r !== null));
            progressBar.update(Math.min(i + batch_size, questionsToProcess.length));
        }

        progressBar.stop();
        
        const processingTime = (Date.now() - startTime) / 1000;
        const cacheHits = results.filter(r => r.cached).length;
        const foundAnswers = results.filter(r => r.found).length;
        
        console.log(`\n✓ Processing completed in ${processingTime.toFixed(2)}s`);
        console.log(`✓ Cache hits: ${cacheHits}/${results.length}`);
        console.log(`✓ Found relevant answers: ${foundAnswers}/${results.length}`);

        // Check if response is still writable
        if (!res.headersSent) {
            res.status(200).json({
                folder: folder_name,
                csv_path: csv_path,
                results: results,
                statistics: {
                    total_questions: questionsToProcess.length,
                    processed_questions: results.length,
                    cache_hits: cacheHits,
                    found_answers: foundAnswers,
                    processing_time_seconds: processingTime,
                    timestamp: new Date().toISOString()
                }
            });
        }

    } catch (error) {
        console.error('Error processing CSV:', error);
        // Only send error response if headers not sent
        if (!res.headersSent) {
            res.status(error.statusCode || 500).json({ 
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }
});

// --- ERROR HANDLING MIDDLEWARE ---
app.use((error, req, res, next) => {
    if (error.code === 'TIMEOUT') {
        return res.status(408).json({ error: 'Request timeout' });
    }
    
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// --- GRACEFUL SHUTDOWN ---
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    markdownCache.clear();
    responseCache.clear();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    markdownCache.clear();
    responseCache.clear();
    process.exit(0);
});

// --- CLUSTER SUPPORT ---
if (CONFIG.use_clustering && cluster.isMaster) {
    const numCPUs = os.cpus().length;
    console.log(`Master ${process.pid} is running`);
    console.log(`Forking ${numCPUs} workers...`);

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died`);
        cluster.fork();
    });
} else {
    // --- START THE SERVER ---
    (async () => {
        try {
            await loadMarkdownCache();
            app.listen(PORT, () => {
                console.log(`🚀 High-Performance Q&A Server running on http://localhost:${PORT}`);
                console.log(`📚 API documentation at http://localhost:${PORT}/api-docs`);
                console.log(`💾 Cache: ${markdownCache.size()} folders loaded`);
                console.log(`⚡ Concurrency: ${CONFIG.max_concurrent_requests} max requests`);
                if (CONFIG.use_clustering) {
                    console.log(`🖥️  Worker ${process.pid} started`);
                }
            });
        } catch (error) {
            console.error('Failed to start server:', error);
            process.exit(1);
        }
    })();
}