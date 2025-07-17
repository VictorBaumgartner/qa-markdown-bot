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
    model_context_tokens: 16384,
    ollama_url: "http://localhost:11434",
    model_name: "llama3.1:8b",
    max_response_length: 500,
    max_concurrent_requests: 10,
    chunk_size: 4000,
    chunk_overlap_ratio: 0.1,
    use_clustering: false
};

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

const compression = require('compression');
app.use(compression());

const timeout = require('connect-timeout');
app.use(timeout('300s'));

const PORT = process.env.PORT || 3000;

// --- OPENAPI SPEC ---
const openApiSpec = {
    openapi: "3.0.3",
    info: {
        title: "Simplified Q&A API",
        version: "8.0.0",
        description: "A simplified API without caching for improved reliability."
    },
    servers: [{ url: `http://192.168.0.64:${PORT}` }],
    paths: {
        "/process-single-question": {
            post: {
                summary: "Process a single question without caching",
                description: "Submits one question and returns a precise answer by reading markdown content in real-time.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    folder_name: { type: "string", example: "crawl_zadkine_paris_fr_1752142903921" },
                                    single_question: { type: "string", example: "Quelles sont les expositions actuelles ?" }
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
                                        found: { type: "boolean" },
                                        timestamp: { type: "string" }
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
                description: "Returns server health status.",
                responses: {
                    "200": { description: "Server is healthy" }
                }
            }
        }
    }
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get('/', (req, res) => res.redirect('/api-docs'));

function chunkText(text, maxChars = CONFIG.chunk_size, overlapRatio = CONFIG.chunk_overlap_ratio) {
    try {
        if (!text || typeof text !== 'string' || text.length <= maxChars) {
            console.log(`chunkText: Text length ${text ? text.length : 0}, returning ${text ? '[text]' : '[]'}`);
            return text ? [text] : [];
        }

        const chunks = [];
        let start = 0;
        const overlap = Math.floor(maxChars * overlapRatio);
        let iterationCount = 0;
        const maxIterations = Math.ceil(text.length / (maxChars - overlap)) + 1;

        while (start < text.length && iterationCount < maxIterations) {
            let end = Math.min(start + maxChars, text.length);

            if (end < text.length) {
                const lastPeriod = text.lastIndexOf('.', end);
                const lastNewline = text.lastIndexOf('\n', end);
                const breakPoint = Math.max(lastPeriod, lastNewline);

                if (breakPoint > start && breakPoint <= end) {
                    end = breakPoint + 1;
                } else {
                    console.warn(`No valid breakpoint found between ${start} and ${end}; using maxChars`);
                }
            }

            console.log(`Chunking: start=${start}, end=${end}, chunkLength=${end - start}`);
            chunks.push(text.substring(start, end));

            start = end - overlap;
            if (start < 0) {
                console.warn(`Negative start index detected (${start}); setting to 0`);
                start = 0;
            }

            iterationCount++;
            if (iterationCount >= maxIterations) {
                console.warn(`Max iterations (${maxIterations}) reached; breaking loop`);
                break;
            }
        }

        console.log(`chunkText: Created ${chunks.length} chunks`);
        return chunks;
    } catch (error) {
        console.error(`Error in chunkText: ${error.message}`, error.stack);
        return [];
    }
}

function scoreChunk(chunk, question) {
    const questionWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const chunkLower = chunk.toLowerCase();
    const matchCount = questionWords.filter(word => chunkLower.includes(word)).length;
    return matchCount / (questionWords.length || 1);
}

function sanitizeInput(input) {
    return input.trim().replace(/[^\w\s\-_.àâäéèêëïîôöùûüÿç]/gi, '');
}

async function readMarkdownFiles(dir, question = '') {
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
    
    const questionWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const baseKeywords = ['exposition', 'exhibition', 'musée', 'museum', 'art', 'collection', 'visite', 'horaire', 'tarif'];
    const relevantKeywords = [...baseKeywords, ...questionWords];
    console.log(`Keywords for filtering: ${relevantKeywords.join(', ')}`);

    const filePromises = files.map(async (file) => {
        const fullPath = path.join(resolvedDir, file.name);
        
        if (file.isDirectory()) {
            return await readMarkdownFiles(fullPath, question);
        } else if (file.name.endsWith('.md')) {
            try {
                const fileContent = await fs.readFile(fullPath, 'utf8');
                const hasRelevantContent = relevantKeywords.length === 0 || relevantKeywords.some(keyword => 
                    fileContent.toLowerCase().includes(keyword)
                );
                
                if (hasRelevantContent || relevantKeywords.length === 0) {
                    console.log(`Including file: ${file.name}`);
                    return `\n\n--- Contenu du fichier: ${file.name} ---\n\n${fileContent}`;
                } else {
                    console.log(`Excluding file: ${file.name} (no keyword match)`);
                }
            } catch (error) {
                console.warn(`Warning: Could not read file ${fullPath}: ${error.message}`);
            }
        }
        return '';
    });

    const results = await Promise.all(filePromises);
    content = results.join('');
    console.log(`Total content length for ${resolvedDir}: ${content.length} characters`);
    
    return content;
}

async function getAnswerFromOllama(question, context) {
    console.log(`Processing question: ${question}`);
    console.log(`Context size: ${context.length} characters`);

    const today = new Date().toLocaleDateString('fr-FR', { 
        day: 'numeric', 
        month: 'long', 
        year: 'numeric' 
    });

    const chunks = chunkText(context);
    console.log(`Number of chunks: ${chunks.length}`);

    if (chunks.length === 0) {
        console.warn('No chunks available; returning default response');
        return {
            answer: "Information insuffisante dans le contexte fourni.",
            found: false
        };
    }

    const scoredChunks = chunks.map(chunk => ({
        chunk,
        score: scoreChunk(chunk, question)
    })).sort((a, b) => b.score - a.score);

    let bestAnswer = null;
    let bestScore = 0;
    let foundRelevantInfo = false;

    for (const { chunk, score } of scoredChunks.slice(0, 5)) {
        console.log(`Processing chunk with relevance score: ${score.toFixed(2)}`);
        const prompt = `Tu es un assistant expert pour un musée. Utilise EXCLUSIVEMENT le CONTEXTE ci-dessous pour répondre à la QUESTION. Fournis une réponse claire, concise et précise en moins de ${CONFIG.max_response_length} caractères. Si les informations sont insuffisantes, indique "Information insuffisante dans le contexte fourni." La date d'aujourd'hui est le ${today}.\n\nCONTEXTE:\n${chunk}\n\nQUESTION:\n${question}\n\nRÉPONSE:`;

        const payload = {
            model: CONFIG.model_name,
            prompt,
            stream: false,
            options: { 
                num_ctx: CONFIG.model_context_tokens,
                temperature: 0.3,
                top_p: 0.9,
                repeat_penalty: 1.1
            }
        };

        try {
            const response = await fetch(`${CONFIG.ollama_url}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                timeout: 30000
            });

            if (!response.ok) {
                throw new Error(`Ollama API Error: ${response.status}`);
            }

            const result = await response.json();
            let answer = result.response ? result.response.trim() : "Information insuffisante dans le contexte fourni.";
            console.log(`Model response: ${answer.substring(0, 100)}...`);

            const isRelevantAnswer = !answer.includes("Information insuffisante") && answer.length > 20;
            const relevanceScore = calculateRelevanceScore(answer, question);

            if (relevanceScore > bestScore && isRelevantAnswer) {
                bestAnswer = answer;
                bestScore = relevanceScore;
                foundRelevantInfo = true;
            }
        } catch (error) {
            console.warn(`Chunk processing failed: ${error.message}`);
            continue;
        }
    }

    const finalAnswer = bestAnswer || "Information insuffisante dans le contexte fourni.";
    console.log(`Final answer: ${finalAnswer.substring(0, 100)}...`);
    return {
        answer: finalAnswer,
        found: foundRelevantInfo
    };
}

function calculateRelevanceScore(answer, question) {
    const answerLower = answer.toLowerCase();
    const questionLower = question.toLowerCase();
    
    const questionWords = questionLower.split(/\s+/).filter(w => w.length > 3);
    const matchCount = questionWords.filter(word => answerLower.includes(word)).length;
    const keywordScore = matchCount / (questionWords.length || 1);

    const idealLength = 200;
    const lengthScore = Math.min(answer.length / idealLength, 1) * (answer.length < 20 ? 0.5 : 1);

    const isGeneric = answer.includes("Information insuffisante") || answer.length < 20;
    const specificityScore = isGeneric ? 0.5 : 1;

    return (keywordScore * 0.6 + lengthScore * 0.2 + specificityScore * 0.2);
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
        
        return questions.filter(q => q.question && q.question.trim().length > 0);
    } catch (error) {
        const userError = new Error("Failed to parse CSV. Ensure 'question' header exists and CSV is properly formatted.");
        userError.statusCode = 400;
        throw userError;
    }
}

// --- ENDPOINTS ---
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        config: {
            max_concurrent: CONFIG.max_concurrent_requests,
            model: CONFIG.model_name,
            cache_disabled: true
        }
    });
});

app.post('/process-single-question', async (req, res) => {
    const { folder_name, single_question } = req.body;
    
    if (!folder_name || !single_question) {
        return res.status(400).json({ 
            error: "Bad Request: 'folder_name' and 'single_question' are required." 
        });
    }

    const sanitizedQuestion = sanitizeInput(single_question);

    console.log(`\n--- Single Question Request ---`);
    console.log(`Folder: ${folder_name}`);
    console.log(`Question: ${sanitizedQuestion}`);

    try {
        // Read markdown files fresh each time
        const folderPath = path.join(CONFIG.network_share_path, folder_name);
        const markdownContent = await readMarkdownFiles(folderPath, sanitizedQuestion);
        
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
            timestamp: new Date().toISOString()
        };

        res.status(200).json(response);

    } catch (error) {
        console.error('Error processing single question:', error);
        res.status(error.statusCode || 500).json({ 
            error: error.message,
            timestamp: new Date().toISOString()
        });
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
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
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
    app.listen(PORT, () => {
        console.log(`🚀 Simplified Q&A Server running on http://localhost:${PORT}`);
        console.log(`📚 API documentation at http://localhost:${PORT}/api-docs`);
        console.log(`⚡ Concurrency: ${CONFIG.max_concurrent_requests} max requests`);
        console.log(`💾 Cache: DISABLED for reliability`);
        if (CONFIG.use_clustering) {
            console.log(`🖥️  Worker ${process.pid} started`);
        }
    });
}