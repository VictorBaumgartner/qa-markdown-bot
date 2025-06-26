const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { createReadStream } = fs;

// --- Configuration ---
const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_LLM_MODEL = "phi3";
const OLLAMA_EMBED_MODEL = "nomic-embed-text";
const TOP_K = 5;
const CRAWL_ROOT_DIR = path.join(__dirname, 'crawl_output_csv');
const QUESTIONS_CSV_PATH = path.join(__dirname, 'questions.csv');
const RESPONSE_DIR = path.join(__dirname, 'reponse');
const CONCURRENT_REQUESTS = 10; // Reduced from 20 to lower memory usage

// Force garbage collection if available
const gc = global.gc ? global.gc : () => console.log('GC not exposed, run with --expose-gc');

// =============================================================================
// FONCTIONS HELPERS
// =============================================================================

async function getEmbedding(text, model) {
    if (!text || text.trim().length === 0) {
        console.warn(`Skipping embedding: Empty or invalid text input`);
        return null;
    }
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: text })
        });
        if (!response.ok) {
            console.error(`Failed to get embedding for model "${model}": ${response.status} ${response.statusText}`);
            if (response.status === 404) {
                console.error(`Model "${model}" not found on Ollama server. Run 'ollama pull ${model}' to install it.`);
            }
            return null;
        }
        const data = await response.json();
        if (!data.embedding) {
            console.error(`No embedding returned for text: "${text.slice(0, 50)}..."`);
            return null;
        }
        return data.embedding;
    } catch (error) {
        console.error(`Error in getEmbedding for model "${model}": ${error.message}`);
        return null;
    }
}

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

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0.0, normA = 0.0, normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function readQuestionsFromCsv(filePath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            return reject(new Error(`Le fichier de questions n'a pas été trouvé : ${filePath}`));
        }
        const questions = [];
        createReadStream(filePath)
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
        if (!response.ok) throw new Error(`Erreur API LLM: ${await response.text()}`);
        const result = await response.json();
        return result.response.trim();
    } catch (error) {
        console.error(`Erreur lors de la génération de la réponse: ${error.message}`);
        return "Erreur lors de la communication avec le modèle de langage.";
    }
}

// =============================================================================
// LOGIQUE D'INDEXATION ROBUSTE
// =============================================================================

async function createVectorIndexForSite(siteDir) {
    const finalIndex = [];
    const files = await getAllFiles(siteDir, '.md');

    if (files.length === 0) {
        console.log(`Aucun fichier .md trouvé dans ${siteDir}`);
        return [];
    }

    let chunkBuffer = [];
    let totalChunksProcessed = 0;
    let skippedChunks = 0;

    for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        try {
            // Read file in chunks using streams
            let fileContent = '';
            await new Promise((resolve, reject) => {
                createReadStream(filePath, { encoding: 'utf8' })
                    .on('data', (chunk) => (fileContent += chunk))
                    .on('end', resolve)
                    .on('error', reject);
            });

            const chunks = fileContent.split(/\n\s*\n/).filter(chunk => chunk.trim().length > 20);
            totalChunksProcessed += chunks.length;

            for (const chunk of chunks) {
                if (chunk.trim().length > 5000) {
                    console.warn(`Skipping chunk in ${filePath}: Too large (${chunk.trim().length} chars)`);
                    skippedChunks++;
                    continue;
                }
                chunkBuffer.push({
                    source: path.relative(siteDir, filePath),
                    text: chunk
                });
            }

            // Process chunks in smaller batches
            while (chunkBuffer.length >= CONCURRENT_REQUESTS) {
                const batchToProcess = chunkBuffer.splice(0, CONCURRENT_REQUESTS);
                process.stdout.write(` -> Fichier ${i + 1}/${files.length} | Indexation de ${batchToProcess.length} chunks... (${totalChunksProcessed} total, ${skippedChunks} skipped)\r`);

                const promises = batchToProcess.map(chunk =>
                    getEmbedding(chunk.text, OLLAMA_EMBED_MODEL).catch(err => {
                        console.error(`Error embedding chunk in ${chunk.source}: ${err.message}`);
                        return null;
                    })
                );
                const results = await Promise.all(promises);

                results.forEach((embedding, index) => {
                    if (embedding) {
                        finalIndex.push({ ...batchToProcess[index], embedding });
                    } else {
                        skippedChunks++;
                    }
                });

                // Trigger garbage collection after each batch
                gc();
            }
        } catch (error) {
            console.error(`Erreur lors du traitement du fichier ${filePath}: ${error.message}`);
        }
    }

    // Process remaining chunks
    if (chunkBuffer.length > 0) {
        process.stdout.write(` -> Traitement du dernier lot de ${chunkBuffer.length} chunks...\n`);
        const promises = chunkBuffer.map(chunk =>
            getEmbedding(chunk.text, OLLAMA_EMBED_MODEL).catch(err => {
                console.error(`Error embedding chunk in ${chunk.source}: ${err.message}`);
                return null;
            })
        );
        const results = await Promise.all(promises);

        results.forEach((embedding, index) => {
            if (embedding) {
                finalIndex.push({ ...chunkBuffer[index], embedding });
            } else {
                skippedChunks++;
            }
        });
        gc();
    }

    process.stdout.write(`\nIndex créé avec ${finalIndex.length} morceaux de texte (${skippedChunks} chunks ignorés).\n`);
    return finalIndex;
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
            const siteVectorIndex = await createVectorIndexForSite(siteDir);
            if (siteVectorIndex.length === 0) {
                console.log("-> Aucun document ou contenu trouvé pour ce site. Passage au suivant.\n");
                continue;
            }

            const siteQaResults = [];
            const notFoundMessage = "L'information n'est pas disponible dans les documents fournis.";

            for (const question of allQuestions) {
                console.log(`\n  -> Question : "${question}"`);
                const questionEmbedding = await getEmbedding(question, OLLAMA_EMBED_MODEL);
                if (!questionEmbedding) {
                    console.log("     Impossible de vectoriser la question. Passage à la suivante.");
                    continue;
                }

                siteVectorIndex.forEach(chunk => {
                    chunk.similarity = cosineSimilarity(questionEmbedding, chunk.embedding);
                });
                siteVectorIndex.sort((a, b) => b.similarity - a.similarity);
                const relevantChunks = siteVectorIndex.slice(0, TOP_K);
                const contextForLLM = relevantChunks
                    .map(chunk => `Source: '${chunk.source}'\nContenu:\n${chunk.text}`)
                    .join('\n\n---\n\n');

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