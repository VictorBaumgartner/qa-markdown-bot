// Import necessary Node.js modules
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // You may need to install: npm install node-fetch

// Configuration
const WORKER_CONFIG = {
    identifier: "qna-worker-01",
    laravel_base_url: "http://192.168.0.43:8000/api",
    network_share_path: "/Users/Shared/CrawledData",
    qna_json_output_path: "/Users/Shared/QAjson", // New path for JSON Q&A storage
    server_ip: "192.168.0.64",
    poll_interval: 5000, // Poll every 5 seconds for new tasks
    max_tokens_per_request: 130000, // 128k tokens for Llama 3.1 8B
    backup_json_locally: true, // Enable local JSON backup
    local_backup_path: "./qna_backup", // Local backup directory
    ollama_url: "http://localhost:11434", // Ollama server URL
    model_name: "llama3.1:8b" // Ollama model to use
};

// Function to ensure directory exists
async function ensureDirectoryExists(dirPath) {
    try {
        // Resolve the path first
        const resolvedPath = path.resolve(dirPath);
        
        // Create directory recursively
        await fs.promises.mkdir(resolvedPath, { recursive: true });
        console.log(`✅ Directory ensured: ${resolvedPath}`);
        
        // Verify it's accessible
        const stats = await fs.promises.stat(resolvedPath);
        if (!stats.isDirectory()) {
            throw new Error(`Path exists but is not a directory: ${resolvedPath}`);
        }
        
        return resolvedPath;
    } catch (error) {
        console.error(`❌ Error creating directory ${dirPath}:`, error);
        throw error;
    }
}

// Function to estimate token count (rough approximation)
function estimateTokenCount(text) {
    // Rough estimation: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
}

// Function to truncate content if it exceeds token limit
function truncateContent(content, maxTokens) {
    const estimatedTokens = estimateTokenCount(content);
    if (estimatedTokens <= maxTokens) {
        return content;
    }
    
    const maxChars = maxTokens * 4;
    const truncated = content.substring(0, maxChars);
    console.warn(`⚠️ Content truncated from ${estimatedTokens} to ~${maxTokens} tokens`);
    return truncated;
}

// Function to save Q&A results as JSON
async function saveQnaAsJson(task, qnaResults) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `qna_${task.id}_${task.folder_name}_${timestamp}.json`;
    
    const jsonData = {
        task_id: task.id,
        folder_name: task.folder_name,
        processed_at: new Date().toISOString(),
        worker_identifier: WORKER_CONFIG.identifier,
        total_questions: qnaResults.length,
        qna_results: qnaResults,
        metadata: {
            api_model: "llama3.1:8b",
            api_provider: "ollama",
            max_tokens_limit: WORKER_CONFIG.max_tokens_per_request,
            ollama_url: WORKER_CONFIG.ollama_url,
            network_share_path: WORKER_CONFIG.network_share_path,
            json_output_path: WORKER_CONFIG.qna_json_output_path
        }
    };
    
    const jsonString = JSON.stringify(jsonData, null, 2);
    
    // Save to network share
    try {
        const networkPath = await ensureDirectoryExists(WORKER_CONFIG.qna_json_output_path);
        const fullNetworkPath = path.join(networkPath, filename);
        await fs.promises.writeFile(fullNetworkPath, jsonString, 'utf8');
        console.log(`✅ JSON saved to network share: ${fullNetworkPath}`);
    } catch (error) {
        console.error('❌ Error saving JSON to network share:', error);
    }
    
    // Save local backup if enabled
    if (WORKER_CONFIG.backup_json_locally) {
        try {
            const localPath = await ensureDirectoryExists(WORKER_CONFIG.local_backup_path);
            const fullLocalPath = path.join(localPath, filename);
            await fs.promises.writeFile(fullLocalPath, jsonString, 'utf8');
            console.log(`✅ JSON backup saved locally: ${fullLocalPath}`);
        } catch (error) {
            console.error('❌ Error saving JSON backup locally:', error);
        }
    }
    
    return filename;
}

// Function to read all Markdown files from a directory and its subdirectories
async function readMarkdownFiles(dir) {
    let markdownContent = '';
    let fileCount = 0;
    
    // Resolve the directory path
    const resolvedDir = path.resolve(dir);
    
    if (!fs.existsSync(resolvedDir)) {
        console.warn(`Directory does not exist: ${resolvedDir}`);
        return { content: '', fileCount: 0 };
    }
    
    try {
        const files = await fs.promises.readdir(resolvedDir, { withFileTypes: true });
        
        for (const file of files) {
            const fullPath = path.join(resolvedDir, file.name);
            
            if (file.isDirectory()) {
                // Skip hidden directories and system folders
                if (file.name.startsWith('.') || file.name === 'node_modules') {
                    continue;
                }
                
                // Recursively read from subdirectories
                const subResult = await readMarkdownFiles(fullPath);
                markdownContent += subResult.content;
                fileCount += subResult.fileCount;
            } else if (file.isFile() && file.name.endsWith('.md')) {
                // Read the content of Markdown files
                console.log(`📄 Reading Markdown file: ${fullPath}`);
                try {
                    const content = await fs.promises.readFile(fullPath, 'utf8');
                    markdownContent += `\n--- FILE: ${file.name} (${fullPath}) ---\n${content}\n`;
                    fileCount++;
                } catch (error) {
                    console.error(`❌ Error reading file ${fullPath}:`, error);
                }
            }
        }
    } catch (error) {
        console.error(`❌ Error reading directory ${resolvedDir}:`, error);
    }
    
    return { content: markdownContent, fileCount };
}

// Function to fetch a task from the Laravel worker endpoint
async function fetchTask() {
    try {
        const response = await fetch(`${WORKER_CONFIG.laravel_base_url}/v1/worker/get-questions-task`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-Worker-Identifier': WORKER_CONFIG.identifier
            }
        });
        
        if (!response.ok) {
            if (response.status === 404) {
                console.log('No tasks available');
                return null;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const task = await response.json();
        console.log('Received task:', JSON.stringify(task, null, 2));
        return task;
    } catch (error) {
        console.error('Error fetching task:', error);
        return null;
    }
}

// Enhanced function to call Ollama Llama 3.1 8B with token management
async function getAnswerFromOllama(question, context) {
    // Truncate context if it exceeds token limit (128k for Llama 3.1)
    const truncatedContext = truncateContent(context, WORKER_CONFIG.max_tokens_per_request - 1000); // Reserve 1000 tokens for question and response
    
    const apiUrl = `http://localhost:11434/api/generate`;
    const prompt = `En vous basant sur le contenu du document suivant, répondez à la question avec précision et concision. Si l'information n'est pas explicitement fournie, indiquez que vous ne trouvez pas la réponse dans le contexte fourni.\n\nContenu du document :\n${truncatedContext}\n\nQuestion : ${question}\n\nRéponse :`;
    
    const payload = {
        model: "llama3.1:8b",
        prompt: prompt,
        stream: false,
        options: {
            temperature: 0.1,
            top_p: 0.9,
            num_ctx: 131072, // 128k context window
            num_predict: 2048 // Max response length
        }
    };
    
    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errorBody = await response.text();
            
            // Check for common Ollama errors
            if (response.status === 404) {
                throw new Error('Model llama3.1:8b not found. Please run: ollama pull llama3.1:8b');
            }
            
            throw new Error(`Ollama API error: ${response.status} - ${errorBody}`);
        }
        
        const result = await response.json();
        
        if (result.response) {
            return result.response.trim();
        } else {
            console.warn("Unexpected Ollama API response structure:", JSON.stringify(result, null, 2));
            return "Could not generate an answer. Unexpected API response.";
        }
    } catch (error) {
        console.error("Error calling Ollama API:", error);
        
        // Check if Ollama is running
        if (error.code === 'ECONNREFUSED') {
            return "Ollama server is not running. Please start it with: ollama serve";
        }
        
        return `Failed to get an answer from the AI: ${error.message}`;
    }
}

// Function to send results back to Laravel
async function sendResults(task, qnaResults) {
    const updatePayload = {
        worker_identifier: WORKER_CONFIG.identifier,
        site_id_laravel: task.id,
        task_type: "ask_questions",
        qna_results: qnaResults,
        message: `Q&A terminé. ${qnaResults.length} réponses trouvées.`
    };
    
    try {
        const response = await fetch(`${WORKER_CONFIG.laravel_base_url}/v1/worker/task-update`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Worker-Identifier': WORKER_CONFIG.identifier
            },
            body: JSON.stringify(updatePayload)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        console.log('Successfully sent results to Laravel:', result);
        return true;
    } catch (error) {
        console.error('Error sending results to Laravel:', error);
        return false;
    }
}

// Function to process a single task
async function processTask(task) {
    console.log(`\n--- Processing Task ID: ${task.id} ---`);
    console.log(`Folder: ${task.folder_name}`);
    console.log(`Questions to ask: ${task.questions_to_ask.length}`);
    
    // Construct the path to the markdown files
    const markdownDirPath = path.join(WORKER_CONFIG.network_share_path, task.folder_name);
    console.log(`Looking for markdown files in: ${markdownDirPath}`);
    
    try {
        // Read all Markdown content from the specified folder and subdirectories
        const { content: allMarkdownContent, fileCount } = await readMarkdownFiles(markdownDirPath);
        
        if (!allMarkdownContent.trim()) {
            console.warn(`No Markdown content found in: ${markdownDirPath}`);
            // Send empty results or error message
            const qnaResults = task.questions_to_ask.map(q => ({
                question: q.question,
                reponse: "Aucun contenu markdown trouvé pour répondre à cette question."
            }));
            
            await sendResults(task, qnaResults);
            await saveQnaAsJson(task, qnaResults);
            return;
        }
        
        console.log(`Found markdown content from ${fileCount} files (${allMarkdownContent.length} characters)`);
        console.log(`Estimated tokens: ${estimateTokenCount(allMarkdownContent)}`);
        
        // Process each question
        const qnaResults = [];
        for (const questionObj of task.questions_to_ask) {
            console.log(`\nProcessing question: ${questionObj.question}`);
            
            const answer = await getAnswerFromOllama(questionObj.question, allMarkdownContent);
            qnaResults.push({
                question: questionObj.question,
                reponse: answer
            });
            
            console.log(`Answer: ${answer}`);
            
            // Add a delay to avoid overloading the local model
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Save Q&A results as JSON
        const jsonFilename = await saveQnaAsJson(task, qnaResults);
        console.log(`📄 Q&A results saved as: ${jsonFilename}`);
        
        // Send results back to Laravel
        const success = await sendResults(task, qnaResults);
        
        if (success) {
            console.log(`✅ Task ${task.id} completed successfully`);
        } else {
            console.log(`❌ Task ${task.id} failed to send results`);
        }
    } catch (error) {
        console.error('Error processing task:', error);
        
        // Send error results
        const qnaResults = task.questions_to_ask.map(q => ({
            question: q.question,
            reponse: `Erreur lors du traitement: ${error.message}`
        }));
        
        await sendResults(task, qnaResults);
        await saveQnaAsJson(task, qnaResults);
    }
}

// Function to check Ollama server and model availability
async function checkOllamaStatus() {
    try {
        // Check if Ollama server is running
        const serverResponse = await fetch(`${WORKER_CONFIG.ollama_url}/api/version`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!serverResponse.ok) {
            console.error('❌ Ollama server is not running. Please start it with: ollama serve');
            return false;
        }
        
        console.log('✅ Ollama server is running');
        
        // Check if the model is available
        const modelsResponse = await fetch(`${WORKER_CONFIG.ollama_url}/api/tags`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (modelsResponse.ok) {
            const models = await modelsResponse.json();
            const modelExists = models.models.some(model => model.name === WORKER_CONFIG.model_name);
            
            if (!modelExists) {
                console.error(`❌ Model ${WORKER_CONFIG.model_name} not found. Please run: ollama pull ${WORKER_CONFIG.model_name}`);
                return false;
            }
            
            console.log(`✅ Model ${WORKER_CONFIG.model_name} is available`);
        }
        
        // Test the model with a simple request
        const testPayload = {
            model: WORKER_CONFIG.model_name,
            prompt: "Hello, this is a test.",
            stream: false,
            options: {
                num_ctx: 131072,
                num_predict: 50
            }
        };
        
        const testResponse = await fetch(`${WORKER_CONFIG.ollama_url}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload)
        });
        
        if (testResponse.ok) {
            console.log('✅ Model test successful');
            return true;
        } else {
            console.error(`❌ Model test failed: ${testResponse.status}`);
            return false;
        }
    } catch (error) {
        console.error('❌ Error testing Ollama:', error);
        console.log('Make sure Ollama is installed and running:');
        console.log('1. Install: curl -fsSL https://ollama.com/install.sh | sh');
        console.log('2. Start server: ollama serve');
        console.log(`3. Pull model: ollama pull ${WORKER_CONFIG.model_name}`);
        return false;
    }
}

// Main worker loop
async function workerLoop() {
    console.log(`🚀 Starting Q&A Worker: ${WORKER_CONFIG.identifier}`);
    console.log(`📍 Network share path: ${resolvedNetworkPath}`);
    console.log(`📁 Q&A JSON output path: ${resolvedJsonPath}`);
    console.log(`🌐 Laravel server: ${WORKER_CONFIG.laravel_base_url}`);
    console.log(`⏰ Poll interval: ${WORKER_CONFIG.poll_interval}ms`);
    console.log(`🤖 Using Ollama model: ${WORKER_CONFIG.model_name}`);
    console.log(`🔗 Ollama server: ${WORKER_CONFIG.ollama_url}`);
    console.log(`🔢 Max tokens per request: ${WORKER_CONFIG.max_tokens_per_request}`);
    
    // Check Ollama status
    const ollamaReady = await checkOllamaStatus();
    if (!ollamaReady) {
        console.error('❌ Ollama not ready. Exiting...');
        return;
    }
    
    // Check if network share paths are accessible
    const resolvedNetworkPath = path.resolve(WORKER_CONFIG.network_share_path);
    const resolvedJsonPath = path.resolve(WORKER_CONFIG.qna_json_output_path);
    
    if (!fs.existsSync(resolvedNetworkPath)) {
        console.error(`❌ Network share not accessible: ${resolvedNetworkPath}`);
        console.log('Please ensure the network share exists and is accessible.');
        console.log('You may need to create it first:');
        console.log(`mkdir -p "${resolvedNetworkPath}"`);
        return;
    }
    
    console.log(`✅ Network share accessible: ${resolvedNetworkPath}`);
    
    // Ensure JSON output directory exists
    try {
        await ensureDirectoryExists(resolvedJsonPath);
        if (WORKER_CONFIG.backup_json_locally) {
            await ensureDirectoryExists(WORKER_CONFIG.local_backup_path);
        }
    } catch (error) {
        console.error('❌ Error setting up directories:', error);
        return;
    }
    
    while (true) {
        try {
            console.log('\n🔍 Checking for new tasks...');
            const task = await fetchTask();
            
            if (task && task.task_type === 'ask_questions') {
                await processTask(task);
            } else if (task) {
                console.log(`⚠️ Received task with unsupported type: ${task.task_type}`);
            }
            
            // Wait before checking for next task
            await new Promise(resolve => setTimeout(resolve, WORKER_CONFIG.poll_interval));
        } catch (error) {
            console.error('Error in worker loop:', error);
            // Wait a bit longer before retrying after an error
            await new Promise(resolve => setTimeout(resolve, WORKER_CONFIG.poll_interval * 2));
        }
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down Q&A Worker...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down Q&A Worker...');
    process.exit(0);
});

// Start the worker
console.log('🏗️ Q&A Worker starting...');
workerLoop().catch(error => {
    console.error('Fatal error in worker:', error);
    process.exit(1);
});