const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const workerpool = require('workerpool');

// --- Configuration ---
const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_LLM_MODEL = "phi3";
const CRAWL_ROOT_DIR = path.join(__dirname, 'crawl_output_csv');
const QUESTIONS_CSV_PATH = path.join(__dirname, 'questions.csv');
const RESPONSE_DIR = path.join(__dirname, 'reponse');
const MAX_WORKERS = Math.max(2, Math.floor(require('os').cpus().length / 2)); // Use half of available CPU cores
const MAX_CONTEXT_SIZE = 5000; // Limit context size to avoid overwhelming the model

// Force garbage collection if available
const gc = global.gc ? global.gc : () => console.log('GC not exposed, run with --expose-gc');

// Ensure response directory exists
if (!fs.existsSync(RESPONSE_DIR)) {
    fs.mkdirSync(RESPONSE_DIR);
}

// =============================================================================
// FONCTIONS HELPERS
// =============================================================================

async function getAllFiles(dir, ext, fileList = []) {
    const files = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            await getAllFiles(fullPath, ext, fileList);
        } else if (file.name.endsWith(ext)) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}

function readQuestionsFromCsv(filePath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            return reject(new Error(`Le fichier de questions n'a pas été trouvé : ${filePath}`));
        }
        const questions = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                const question = Object.values(row)[0];
                if (question && question.trim()) {
                    questions.push(question.trim());
                }
            })
            .on('end', () => resolve(questions))
            .on('error', reject);
    });
}

async function getAnswerFromOllama(question, context) {
    const prompt = `En te basant STRICTEMENT et UNIQUEMENT sur le CONTEXTE fourni ci-dessous, réponds à la QUESTION. Si la réponse ne se trouve pas dans le CONTEXTE, réponds EXACTEMENT : "L'information n'est pas disponible dans les documents fournis.".
### CONTEXTE ###
${context}
### QUESTION ###
${question}
### RÉPONSE ###
`;
    const payload = { model: OLLAMA_LLM_MODEL, prompt, stream: false };
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error(`Failed to get answer from Ollama: ${response.status} ${response.statusText}`);
            if (response.status === 404) {
                console.error(`Model "${OLLAMA_LLM_MODEL}" not found on Ollama server. Run 'ollama pull ${OLLAMA_LLM_MODEL}' to install it.`);
            }
            throw new Error(`Erreur API LLM: ${await response.text()}`);
        }
        const result = await response.json();
        return result.response.trim();
    } catch (error) {
        console.error(`Erreur lors de la génération de la réponse pour "${question.slice(0, 50)}...": ${error.message}`);
        return "Erreur lors de la communication avec le modèle de langage.";
    }
}

// Worker function for processing files
async function processFile(filePath, siteDir) {
    const fs = require('fs'); // Import fs in worker context
    try {
        let fileContent = '';
        await new Promise((resolve, reject) => {
            fs.createReadStream(filePath, { encoding: 'utf8' })
                .on('data', (chunk) => (fileContent += chunk))
                .on('end', resolve)
                .on('error', reject);
        });

        const chunks = fileContent.split(/\n\s*\n/).filter(chunk => chunk.trim().length > 20);
        const chunkData = [];

        for (const chunk of chunks) {
            if (chunk.trim().length > MAX_CONTEXT_SIZE) {
                console.warn(`Skipping chunk in ${filePath}: Too large (${chunk.trim().length} chars)`);
                continue;
            }
            chunkData.push({
                source: path.relative(siteDir, filePath),
                text: chunk
            });
        }
        return chunkData;
    } catch (error) {
        console.error(`Erreur lors du traitement du fichier ${filePath}: ${error.message}`);
        return [];
    }
}

// =============================================================================
// LOGIQUE DE TRAITEMENT DES SITES
// =============================================================================

async function processSite(siteDir, allQuestions) {
    const siteQaResults = [];
    const notFoundMessage = "L'information n'est pas disponible dans les documents fournis.";
    
    const files = await getAllFiles(siteDir, '.md');
    if (files.length === 0) {
        console.log(`Aucun fichier .md trouvé dans ${siteDir}`);
        return siteQaResults;
    }

    let chunkBuffer = [];
    let totalChunksProcessed = 0;
    let skippedChunks = 0;

    // Create a worker pool
    const pool = workerpool.pool({ maxWorkers: MAX_WORKERS });

    // Process files in parallel
    const fileChunksPromises = files.map(file => pool.exec(processFile, [file, siteDir]));
    const fileChunksResults = await Promise.all(fileChunksPromises);

    // Terminate the pool
    await pool.terminate();

    // Flatten chunks
    for (const chunks of fileChunksResults) {
        chunkBuffer.push(...chunks);
        totalChunksProcessed += chunks.length;
    }

    // Create context from chunks (limit total size)
    let contextForLLM = chunkBuffer
        .map(chunk => `Source: '${chunk.source}'\nContenu:\n${chunk.text}`)
        .join('\n\n---\n\n');
    
    if (contextForLLM.length > MAX_CONTEXT_SIZE * 10) {
        contextForLLM = contextForLLM.slice(0, MAX_CONTEXT_SIZE * 10);
        console.warn(`Context truncated to ${MAX_CONTEXT_SIZE * 10} chars for ${siteDir}`);
    }

    process.stdout.write(`\nIndex créé avec ${chunkBuffer.length} morceaux de texte (${skippedChunks} chunks ignorés).\n`);

    // Process questions
    for (const question of allQuestions) {
        console.log(`  -> Question : "${question}"`);
        const answer = await getAnswerFromOllama(question, contextForLLM);
        console.log(`     <- Réponse : ${answer}`);

        if (!answer.includes(notFoundMessage)) {
            siteQaResults.push({ question, answer });
            console.log("       -> Réponse pertinente, ajoutée aux résultats.");
        } else {
            console.log("       -> Réponse contenant 'L'information n'est pas disponible', ignorée pour le JSON.");
        }
        gc();
    }

    return siteQaResults;
}

// =============================================================================
// POINT D'ENTRÉE DU SCRIPT (MAIN)
// =============================================================================

async function main() {
    try {
        console.log("Démarrage du processus...");
        if (!fs.existsSync(RESPONSE_DIR)) {
            fs.mkdirSync(RESPONSE_DIR);
            console.log(`Dossier de sortie créé : ${RESPONSE_DIR}`);
        }

        const allQuestions = await readQuestionsFromCsv(QUESTIONS_CSV_PATH);
        if (allQuestions.length === 0) {
            console.error("Aucune question trouvée dans le CSV. Arrêt.");
            return;
        }
        console.log(`${allQuestions.length} questions ont été chargées.`);

        const siteFolders = (await fs.promises.readdir(CRAWL_ROOT_DIR, { withFileTypes: true }))
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        if (siteFolders.length === 0) {
            console.error(`Aucun dossier de site trouvé dans ${CRAWL_ROOT_DIR}. Arrêt.`);
            return;
        }
        console.log(`${siteFolders.length} sites à traiter.\n`);

        for (const siteName of siteFolders) {
            console.log(`=======================================================`);
            console.log(`Traitement du site : ${siteName}`);
            console.log(`=======================================================`);
            const siteDir = path.join(CRAWL_ROOT_DIR, siteName);
            const siteQaResults = await processSite(siteDir, allQuestions);

            const outputFilename = `${siteName}_reponse.json`;
            const outputPath = path.join(RESPONSE_DIR, outputFilename);
            await fs.promises.writeFile(outputPath, JSON.stringify(siteQaResults, null, 2));
            console.log(`\n✅ Résultats pour le site ${siteName} sauvegardés dans : ${outputPath}`);
        }

        console.log("\n=======================================================\n🎉 Tous les sites ont été traités avec succès !\n=======================================================");
    } catch (error) {
        console.error('\n❌ Une erreur fatale est survenue :', error);
    }
}

main();