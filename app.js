// app.js

// --- Dépendances ---
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const csv = require('csv-parser');
const readline = require('readline');
const os = require('os');

// --- Configuration ---
const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_LLM_MODEL = "phi3";
const CRAWL_ROOT_DIR = path.join(__dirname, 'crawl_output_csv');
const QUESTIONS_CSV_PATH = path.join(__dirname, 'questions.csv');
const RESPONSE_DIR = path.join(__dirname, 'reponse');
const REQUEST_DELAY = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_CONTEXT_CHUNKS = 7;
const MAX_CHUNK_SIZE_FOR_CONTEXT = 3500;

// Mots à ignorer pour la recherche
const FRENCH_STOP_WORDS = new Set(['a', 'afin', 'ai', 'alors', 'au', 'aucun', 'aussi', 'autre', 'aux', 'avec', 'car', 'ce', 'ces', 'comme', 'dans', 'de', 'des', 'donc', 'dont', 'du', 'elle', 'en', 'est', 'et', 'eux', 'il', 'ils', 'je', 'la', 'le', 'les', 'leur', 'lui', 'ma', 'mais', 'me', 'mes', 'moi', 'mon', 'ne', 'nos', 'notre', 'nous', 'on', 'ou', 'où', 'par', 'pas', 'pour', 'qu', 'que', 'qui', 'sa', 'se', 'ses', 'son', 'sont', 'sur', 'ta', 'te', 'tes', 'toi', 'ton', 'tu', 'un', 'une', 'vos', 'votre', 'vous']);

// =============================================================================
// NOUVEAU : SYSTÈME DE SCORING POUR UN FILTRAGE INTELLIGENT
// =============================================================================

// Mots qui augmentent fortement la pertinence d'un chunk
const POSITIVE_KEYWORDS = {
    'musée': 5, 'exposition': 5, 'collection': 4, 'galerie': 4, 'oeuvre': 4, 
    'artiste': 3, 'billet': 3, 'tarif': 3, 'horaires': 3, 'visite': 2, 
    'sculpture': 2, 'peinture': 2, 'archéologie': 2, 'patrimoine': 2
};

// Mots qui indiquent un contexte polluant et diminuent la pertinence
const NEGATIVE_KEYWORDS = {
    'transport': -5, 'bus': -5, 'mairie': -4, 'administratif': -4, 'séance': -4,
    'cabinet': -4, 'médical': -4, 'docteur': -4, 'urbanisme': -3, 'démarches': -3
};


// NOUVEAU : Mots-clés pour filtrer les chunks et ne garder que le contenu pertinent sur les musées
const MUSEUM_KEYWORDS = [
    'musée', 'exposition', 'collection', 'galerie', 'visite', 'billet',
    'tarif', 'horaires', 'oeuvre', 'artiste', 'sculpture', 'peinture',
    'archéologie', 'patrimoine', 'culturel', 'salle', 'exposition',
    'conservateur', 'visiteur'
];

// Phrases indiquant que la réponse n'a PAS été trouvée
const NON_INFORMATIVE_RESPONSES = [
    "l'information n'est pas disponible", "la réponse ne se trouve pas", "je ne peux pas répondre",
    "je ne trouve pas d'information", "la réponse à cette question ne peut pas être trouvée",
    "aucune information", "documents fournis ne contiennent pas", "documents ne précisent pas"
];

const gc = global.gc ? global.gc : () => {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// =============================================================================
// FONCTION DE RECHERCHE DE CONTEXTE (LISANT DEPUIS UN FICHIER INDEX)
// =============================================================================
async function findRelevantContextFromFile(question, indexPath) {
    const questionWords = question.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
    const keywords = questionWords.filter(word => !FRENCH_STOP_WORDS.has(word) && word.length > 2);
    
    let topChunks = [];

    if (keywords.length > 0) {
        const fileStream = fs.createReadStream(indexPath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        for await (const line of rl) {
            if (line.trim() === '') continue;
            const chunk = JSON.parse(line);
            const chunkText = chunk.text.toLowerCase();
            let score = 0;
            for (const keyword of keywords) {
                score += (chunkText.match(new RegExp(`\\b${keyword}\\b`, 'g')) || []).length;
            }
            if (score > 0) {
                topChunks.push({ ...chunk, score });
            }
        }
        
        topChunks.sort((a, b) => b.score - a.score);
        topChunks = topChunks.slice(0, MAX_CONTEXT_CHUNKS);
    }

    let context = "";
    let contextLength = 0;

    // PLAN B : Si la recherche ne donne rien, on prendra les premiers chunks du fichier
    if (topChunks.length === 0) {
        console.warn("       -> ⚠️ La recherche n'a rien donné. Utilisation du contexte par défaut (début du site).");
        const fileStream = fs.createReadStream(indexPath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
        for await (const line of rl) {
            if (line.trim() === '') continue;
            if (topChunks.length >= MAX_CONTEXT_CHUNKS) break;
            topChunks.push(JSON.parse(line));
        }
    }
    
    for (const chunk of topChunks) {
        const chunkContent = `Source: '${chunk.source}'\nContenu:\n${chunk.text}\n\n---\n\n`;
        if (contextLength + chunkContent.length <= MAX_CHUNK_SIZE_FOR_CONTEXT) {
            context += chunkContent;
            contextLength += chunkContent.length;
        }
    }
    
    return context.length > 0 ? context : "Aucune information n'a pu être extraite des documents.";
}

// =============================================================================
// LOGIQUE DE TRAITEMENT PRINCIPALE (AVEC FILTRE DE PERTINENCE)
// =============================================================================
async function processSite(siteDir, allQuestions, serverAvailable) {
    const siteQaResults = [];
    const indexPath = path.join(os.tmpdir(), `index_${path.basename(siteDir)}_${Date.now()}.jsonl`);

    // --- Phase 1: Indexation sur disque AVEC SCORING DE PERTINENCE ---
    console.log(`\nPhase 1: Indexation et scoring de ${siteDir}`);
    const files = await getAllFiles(siteDir, '.md');
    if (files.length === 0) { console.log(`Aucun fichier .md trouvé.`); return []; }

    const writeStream = fs.createWriteStream(indexPath);
    let relevantChunksCount = 0;

    for (const file of files) {
        try {
            const content = await fsPromises.readFile(file, 'utf8');
            const relativePath = path.relative(siteDir, file);
            // On filtre les chunks trop courts pour être significatifs
            const textChunks = content.split('\n\n').filter(chunk => chunk.trim().length > 50);

            for (const [index, chunkText] of textChunks.entries()) {
                // --- CORRECTION N°1 : SCORING ANTI-BRUIT ---
                const chunkTextLower = chunkText.toLowerCase();
                let score = 0;
                // Calcul du score positif
                for (const [key, value] of Object.entries(POSITIVE_KEYWORDS)) {
                    if (chunkTextLower.includes(key)) score += value;
                }
                // Calcul du score négatif
                for (const [key, value] of Object.entries(NEGATIVE_KEYWORDS)) {
                    if (chunkTextLower.includes(key)) score += value;
                }

                // On ne conserve QUE les chunks avec un score strictement positif
                if (score > 0) {
                    const chunk = { source: `${relativePath}#chunk${index + 1}`, text: chunkText };
                    writeStream.write(JSON.stringify(chunk) + '\n');
                    relevantChunksCount++;
                }
            }
        } catch (error) { console.error(`Erreur sur ${file}: ${error.message}`); }
    }
    writeStream.end();
    await new Promise(resolve => writeStream.on('finish', resolve));

    if (relevantChunksCount === 0) {
        console.error(`\n❌ CRITIQUE: Aucun chunk pertinent trouvé pour ${siteDir} après filtrage. Traitement annulé.`);
        try { await fsPromises.unlink(indexPath); } catch (e) {}
        return [];
    }
    console.log(`Indexation terminée. ${relevantChunksCount} morceaux de texte hautement pertinents conservés.`);

    // --- Phase 2: Q&A en utilisant l'index propre ---
    console.log(`\nPhase 2: Début de la Q&A...`);
    for (const question of allQuestions) {
        console.log(`\n  -> Question : "${question}"`);
        const contextForLLM = await findRelevantContextFromFile(question, indexPath);
        // La fonction getAnswerFromOllama contient maintenant la conscience temporelle
        const answer = serverAvailable ? await getAnswerFromOllama(question, contextForLLM) : "Ollama server unavailable.";
        console.log(`     <- Réponse : ${answer}`);

        // --- CORRECTION N°3 : LOGIQUE DE CLASSIFICATION STRICTE ---
        const cleanedAnswer = answer.toLowerCase().trim();
        let reponseTrouvee;

        const isError = answer.includes("Erreur lors de la communication") || answer.includes("unavailable");
        // La détection est maintenant plus large et robuste
        const isNonInformative = NON_INFORMATIVE_PHRASES.some(phrase => cleanedAnswer.includes(phrase));
        
        if (isError) {
            reponseTrouvee = "erreur";
        } else if (isNonInformative) {
            reponseTrouvee = "non"; // Le modèle a explicitement dit qu'il ne savait pas
        } else {
            reponseTrouvee = "oui"; // Tous les autres cas sont une réponse trouvée
        }
        
        siteQaResults.push({ question, answer, reponse_trouvee: reponseTrouvee });
        
        if (reponseTrouvee === "oui") {
            console.log("       -> ✅ Réponse trouvée. Classification: 'oui'.");
        } else if (reponseTrouvee === "non") {
            console.log("       -> ❌ Réponse non trouvée. Classification: 'non'.");
        } else {
            console.log("       -> ⚠️ Erreur technique. Classification: 'erreur'.");
        }

        await delay(REQUEST_DELAY);
    }

    // --- Phase 3: Nettoyage ---
    try {
        await fsPromises.unlink(indexPath);
        console.log(`\nFichier d'index temporaire supprimé.`);
    } catch (error) {
        console.error(`Impossible de supprimer l'index: ${error.message}`);
    }

    return siteQaResults;
}


// =============================================================================
// FONCTIONS UTILITAIRES DÉTAILLÉES
// =============================================================================

/**
 * Liste récursivement tous les fichiers d'un dossier avec une extension donnée.
 */

async function getAllFiles(dir, ext, fileList = []) {
    try {
        const files = await fsPromises.readdir(dir, { withFileTypes: true });
        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                await getAllFiles(fullPath, ext, fileList);
            } else if (file.name.endsWith(ext)) {
                fileList.push(fullPath);
            }
        }
        return fileList;
    } catch (error) {
        console.error(`Erreur lors de la lecture du dossier ${dir}: ${error.message}`);
        return fileList;
    }
}

/**
 * Lit les questions depuis un fichier CSV.
 */
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
            .on('end', () => {
                console.log(`Questions chargées depuis ${filePath}: ${questions.length}`);
                resolve(questions);
            })
            .on('error', (error) => {
                reject(new Error(`Erreur lors de la lecture du CSV ${filePath}: ${error.message}`));
            });
    });
}

/**
 * Vérifie la disponibilité du serveur Ollama et du modèle requis.
 */
async function checkOllamaServer() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`Ollama server responded with status ${response.status}`);
        
        const models = await response.json();
        if (!models.models.some(model => model.name.includes(OLLAMA_LLM_MODEL))) {
            throw new Error(`Model "${OLLAMA_LLM_MODEL}" not found on server. Run 'ollama pull ${OLLAMA_LLM_MODEL}'.`);
        }
        console.log('Ollama server is running and model is available.');
        return true;
    } catch (error) {
        console.error(`Failed to connect to Ollama server at ${OLLAMA_BASE_URL}: ${error.message}`);
        return false;
    }
}

/**
 * Envoie une requête à Ollama et gère les nouvelles tentatives.
 */
async function getAnswerFromOllama(question, context) {
    const prompt = `Tu es un assistant dédié à l'accueil des visiteurs d'un musée. En te basant uniquement sur les informations fournies dans le CONTEXTE ci-dessous, réponds avec courtoisie à la QUESTION. Si le CONTEXTE ne contient pas l'information demandée, réponds de manière polie sans inventer de contenu ni mentionner l'absence d'information.
    De plus et pour info, la date d'aujourd'hui est le ${today}. Évalue la pertinence des dates dans le CONTEXTE par rapport à cette date.
    En te basant uniquement sur le CONTEXTE, réponds à la QUESTION. Si la réponse ne s'y trouve pas ou est périmée (ex: une exposition de 2021), réponds "Je ne trouve pas d'information pertinente et à jour dans les documents fournis.".

    ### CONTEXTE ###
    ${context}

    ### QUESTION ###
    ${question}

    ### RÉPONSE ###
    `;

    const payload = { model: OLLAMA_LLM_MODEL, prompt, stream: false };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000); // Timeout de 60 secondes
            const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) throw new Error(`API error: ${response.status} ${response.statusText} - ${await response.text()}`);

            const result = await response.json();
            if (!result.response) throw new Error('Missing "response" field in Ollama result');

            return result.response.trim();
        } catch (error) {
            console.error(`Erreur Ollama (attempt ${attempt}/${MAX_RETRIES}): ${error.message}`);
            if (attempt < MAX_RETRIES) {
                console.log(`Nouvel essai dans ${RETRY_DELAY / 1000}s...`);
                await delay(RETRY_DELAY);
            }
        }
    }
    return "Erreur lors de la communication avec le modèle de langage.";
}


// =============================================================================
// POINT D'ENTRÉE DU SCRIPT (MAIN)
// =============================================================================
async function main() {
    try {
        console.log("Démarrage du processus de Q&A...");
        let serverAvailable = await checkOllamaServer();
        if (!fs.existsSync(RESPONSE_DIR)) fs.mkdirSync(RESPONSE_DIR, { recursive: true });
        if (!fs.existsSync(CRAWL_ROOT_DIR)) throw new Error(`Le dossier racine ${CRAWL_ROOT_DIR} n'existe pas.`);
        
        const allQuestions = await readQuestionsFromCsv(QUESTIONS_CSV_PATH);
        if (allQuestions.length === 0) {
            console.error("Aucune question trouvée. Arrêt.");
            return;
        }

        const siteFolders = (await fsPromises.readdir(CRAWL_ROOT_DIR, { withFileTypes: true }))
            .filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
        
        if (siteFolders.length === 0) {
            console.error("Aucun site trouvé. Arrêt.");
            return;
        }
        console.log(`\nTrouvé ${siteFolders.length} sites à traiter.`);

        let processedCount = 0;
        for (const siteName of siteFolders) {
            processedCount++;
            console.log(`\n=======================================================`);
            console.log(`TRAITEMENT DU SITE : ${siteName} (${processedCount}/${siteFolders.length})`);
            console.log(`=======================================================`);
            
            if (!serverAvailable) serverAvailable = await checkOllamaServer();
            
            const siteDir = path.join(CRAWL_ROOT_DIR, siteName);
            let siteQaResults = [];
            try {
                siteQaResults = await processSite(siteDir, allQuestions, serverAvailable);
            } catch (error) {
                console.error(`Erreur critique sur le site ${siteName}: ${error.message}`);
            }

            const outputPath = path.join(RESPONSE_DIR, `${siteName}_reponse.json`);
            try {
                await fsPromises.writeFile(outputPath, JSON.stringify(siteQaResults, null, 2), 'utf8');
                console.log(`\n✅ Résultats pour ${siteName} sauvegardés dans : ${outputPath}`);
            } catch (error) {
                console.error(`Erreur d'écriture pour ${outputPath}: ${error.message}`);
            }
            if (global.gc) gc(); // Nettoyage mémoire entre chaque site
        }
        console.log("\n=======================================================\n🎉 Tous les sites ont été traités !\n=======================================================");
    } catch (error) {
        console.error('\n❌ Une erreur fatale a arrêté le script principal :', error);
    }
}

// --- Lancement du Script ---
main();