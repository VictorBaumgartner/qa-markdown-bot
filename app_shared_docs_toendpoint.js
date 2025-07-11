// Import necessary Node.js modules
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // You may need to install: npm install node-fetch

// IMPORTANT: Replace with your actual Gemini API Key.
// In a real application, you'd load this from environment variables (e.g., process.env.GEMINI_API_KEY)
// for security. For this example, you can paste it directly, but be careful not to commit it to public repos.
const API_KEY = "";

// Configuration
const WORKER_CONFIG = {
    identifier: "qna-worker-01",
    laravel_base_url: "192.168.0.43:8000/api", 
    network_share_path: "/Volumes/CrawledData", 
    server_ip: "192.168.0.64", 
    poll_interval: 5000 // Poll every 5 seconds for new tasks
};

// Function to read all Markdown files from a directory and its subdirectories
async function readMarkdownFiles(dir) {
    let markdownContent = '';
    
    if (!fs.existsSync(dir)) {
        console.warn(`Directory does not exist: ${dir}`);
        return '';
    }

    try {
        const files = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                // Recursively read from subdirectories
                markdownContent += await readMarkdownFiles(fullPath);
            } else if (file.isFile() && file.name.endsWith('.md')) {
                // Read the content of Markdown files
                console.log(`Reading Markdown file: ${fullPath}`);
                try {
                    const content = await fs.promises.readFile(fullPath, 'utf8');
                    markdownContent += `\n--- FILE: ${file.name} ---\n${content}\n`;
                } catch (error) {
                    console.error(`Error reading file ${fullPath}:`, error);
                }
            }
        }
    } catch (error) {
        console.error(`Error reading directory ${dir}:`, error);
    }

    return markdownContent;
}

// Function to fetch a task from the Laravel worker endpoint
async function fetchTask() {
    try {
        const response = await fetch(`${WORKER_CONFIG.laravel_base_url}/api/v1/worker/get-questions-task`, {
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

// Function to call the Gemini API for generating answers
async function getAnswerFromGemini(question, context) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

    const prompt = `En vous basant sur le contenu du document suivant, répondez à la question avec précision et concision. Si l'information n'est pas explicitement fournie, indiquez que vous ne trouvez pas la réponse dans le contexte fourni.\n\nContenu du document :\n${context}\n\nQuestion : ${question}\n\nRéponse :`;

    const chatHistory = [];
    chatHistory.push({ role: "user", parts: [{ text: prompt }] });

    const payload = { contents: chatHistory };

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini API error: ${response.status} - ${errorBody}`);
        }

        const result = await response.json();
        if (result.candidates && result.candidates.length > 0 &&
            result.candidates[0].content && result.candidates[0].content.parts &&
            result.candidates[0].content.parts.length > 0) {
            return result.candidates[0].content.parts[0].text;
        } else {
            console.warn("Unexpected Gemini API response structure:", JSON.stringify(result, null, 2));
            return "Could not generate an answer. Unexpected API response.";
        }
    } catch (error) {
        console.error("Error calling Gemini API:", error);
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
        const response = await fetch(`${WORKER_CONFIG.laravel_base_url}/api/v1/worker/task-update`, {
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
        // Read all Markdown content from the specified folder
        const allMarkdownContent = await readMarkdownFiles(markdownDirPath);
        
        if (!allMarkdownContent.trim()) {
            console.warn(`No Markdown content found in: ${markdownDirPath}`);
            // Send empty results or error message
            const qnaResults = task.questions_to_ask.map(q => ({
                question: q.question,
                reponse: "Aucun contenu markdown trouvé pour répondre à cette question."
            }));
            await sendResults(task, qnaResults);
            return;
        }

        console.log(`Found markdown content (${allMarkdownContent.length} characters)`);

        // Process each question
        const qnaResults = [];
        for (const questionObj of task.questions_to_ask) {
            console.log(`\nProcessing question: ${questionObj.question}`);
            
            const answer = await getAnswerFromGemini(questionObj.question, allMarkdownContent);
            
            qnaResults.push({
                question: questionObj.question,
                reponse: answer
            });
            
            console.log(`Answer: ${answer}`);
            
            // Add a small delay to avoid hitting API rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

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
    }
}

// Main worker loop
async function workerLoop() {
    console.log(`🚀 Starting Q&A Worker: ${WORKER_CONFIG.identifier}`);
    console.log(`📍 Network share path: ${WORKER_CONFIG.network_share_path}`);
    console.log(`🌐 Laravel server: ${WORKER_CONFIG.laravel_base_url}`);
    console.log(`⏰ Poll interval: ${WORKER_CONFIG.poll_interval}ms`);

    if (!API_KEY) {
        console.error('❌ GEMINI API_KEY is not set. Please add your API key to the configuration.');
        return;
    }

    // Check if network share is accessible
    if (!fs.existsSync(WORKER_CONFIG.network_share_path)) {
        console.error(`❌ Network share not accessible: ${WORKER_CONFIG.network_share_path}`);
        console.log('Please ensure the network share is mounted and accessible.');
        return;
    }

    while (true) {
        try {
            console.log('\n🔍 Checking for new tasks...');
            
            const task = await fetchTask();
            
            if (task && task.task_type === 'ask_questions') {
                await processTask(task);
            } else if (task) {
                console.log(`⚠️  Received task with unsupported type: ${task.task_type}`);
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
console.log('🏗️  Q&A Worker starting...');
workerLoop().catch(error => {
    console.error('Fatal error in worker:', error);
    process.exit(1);
});