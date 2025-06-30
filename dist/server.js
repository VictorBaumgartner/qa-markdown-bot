"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const csv_parser_1 = __importDefault(require("csv-parser"));
const leven_1 = __importDefault(require("leven"));
const url_1 = require("url");
const HOST = "localhost";
const PORT = 3003;
const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_LLM_MODEL = "phi3";
const CRAWL_ROOT_DIR = path_1.default.join(__dirname, '..', 'crawl_output_csv');
const QUESTIONS_CSV_PATH = path_1.default.join(__dirname, '..', 'questions.csv');
const REQUEST_DELAY = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_CONTEXT_CHUNKS = 7;
const MAX_CHUNK_SIZE_FOR_CONTEXT = 3500;
const FRENCH_STOP_WORDS = new Set(['a', 'afin', 'ai', 'alors', 'au', 'aucun', 'aussi', 'autre', 'aux', 'avec', 'car', 'ce', 'ces', 'comme', 'dans', 'de', 'des', 'donc', 'dont', 'du', 'elle', 'en', 'est', 'et', 'eux', 'il', 'ils', 'je', 'la', 'le', 'les', 'leur', 'lui', 'ma', 'mais', 'me', 'mes', 'moi', 'mon', 'ne', 'nos', 'notre', 'nous', 'on', 'ou', 'où', 'par', 'pas', 'pour', 'qu', 'que', 'qui', 'sa', 'se', 'ses', 'son', 'sont', 'sur', 'ta', 'te', 'tes', 'toi', 'ton', 'tu', 'un', 'une', 'vos', 'votre', 'vous']);
const POSITIVE_KEYWORDS = { 'musée': 5, 'exposition': 5, 'collection': 4, 'galerie': 4, 'oeuvre': 4, 'artiste': 3, 'billet': 3, 'tarif': 3, 'horaires': 3, 'visite': 2, 'sculpture': 2, 'peinture': 2, 'archéologie': 2, 'patrimoine': 2 };
const NEGATIVE_KEYWORDS = { 'transport': -5, 'bus': -5, 'mairie': -4, 'administratif': -4, 'séance': -4, 'cabinet': -4, 'médical': -4, 'docteur': -4, 'urbanisme': -3, 'démarches': -3 };
const NON_INFORMATIVE_RESPONSES = ["l'information n'est pas disponible", "la réponse ne se trouve pas", "je ne peux pas répondre", "je ne trouve pas d'information", "la réponse à cette question ne peut pas être trouvée", "aucune information", "documents fournis ne contiennent pas", "documents ne précisent pas", "je ne trouve pas d'information pertinente et à jour"];
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function readQuestionsFromCsv(filePath) {
    return new Promise((resolve, reject) => {
        if (!fs_1.default.existsSync(filePath)) {
            return reject(new Error(`Le fichier de questions n'a pas été trouvé : ${filePath}`));
        }
        const questions = [];
        fs_1.default.createReadStream(filePath)
            .pipe((0, csv_parser_1.default)({
            headers: false,
            separator: ','
        }))
            .on('data', (row) => {
            const question = row['0'];
            if (question && question.trim() && question.trim().length > 0) {
                questions.push(question.trim());
            }
        })
            .on('end', () => {
            console.log(`Questions chargées depuis ${filePath}: ${questions.length}`);
            if (questions.length === 0) {
                console.warn("⚠️ Aucune question trouvée dans le fichier CSV");
            }
            resolve(questions);
        })
            .on('error', (error) => {
            console.error('Erreur lors de la lecture du CSV:', error);
            reject(error);
        });
    });
}
async function getAnswerFromOllama(question, context) {
    const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const prompt = `Tu es un assistant dédié à l'accueil des visiteurs d'un musée. En te basant uniquement sur les informations fournies dans le CONTEXTE ci-dessous, réponds avec courtoisie à la QUESTION.
    Pour information, la date d'aujourd'hui est le ${today}. Évalue la pertinence des dates dans le CONTEXTE par rapport à cette date.
    Si le CONTEXTE ne contient pas l'information demandée, ou si l'information est clairement périmée (ex: une exposition de 2021), réponds "Je ne trouve pas d'information pertinente et à jour dans les documents fournis.". N'invente jamais de réponse.

    ### CONTEXTE ###
    ${context}

    ### QUESTION ###
    ${question}

    ### RÉPONSE ###
    `;
    const payload = { model: OLLAMA_LLM_MODEL, prompt, stream: false };
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`Tentative ${attempt}/${MAX_RETRIES} pour Ollama...`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);
            const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error: ${response.status} - ${errorText}`);
            }
            const result = await response.json();
            const answer = result.response?.trim();
            if (!answer) {
                throw new Error("Réponse vide du modèle");
            }
            return answer;
        }
        catch (error) {
            console.error(`Erreur Ollama (tentative ${attempt}/${MAX_RETRIES}): ${error.message}`);
            if (attempt < MAX_RETRIES) {
                console.log(`Attente de ${RETRY_DELAY}ms avant nouvelle tentative...`);
                await delay(RETRY_DELAY);
            }
        }
    }
    return "Erreur lors de la communication avec le modèle de langage.";
}
async function processSite(siteDir, allQuestions) {
    const siteQaResults = [];
    const indexPath = path_1.default.join(os_1.default.tmpdir(), `index_${path_1.default.basename(siteDir)}_${Date.now()}.jsonl`);
    try {
        console.log(`\nPhase 1: Indexation et scoring de ${path_1.default.basename(siteDir)}`);
        if (!fs_1.default.existsSync(siteDir)) {
            throw new Error(`Le dossier ${siteDir} n'existe pas`);
        }
        const findMarkdownFiles = (dir) => {
            const files = [];
            const items = fs_1.default.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path_1.default.join(dir, item.name);
                if (item.isDirectory()) {
                    files.push(...findMarkdownFiles(fullPath));
                }
                else if (item.isFile() && item.name.endsWith('.md')) {
                    files.push(fullPath);
                }
            }
            return files;
        };
        const files = findMarkdownFiles(siteDir);
        console.log(`Fichiers .md trouvés: ${files.length}`);
        if (files.length === 0) {
            console.log(`Aucun fichier .md trouvé dans ${siteDir}`);
            return [];
        }
        const writeStream = fs_1.default.createWriteStream(indexPath);
        let relevantChunksCount = 0;
        for (const file of files) {
            try {
                const content = await fs_1.default.promises.readFile(file, 'utf8');
                const relativePath = path_1.default.relative(siteDir, file);
                const textChunks = content.split('\n\n').filter(chunk => chunk.trim().length > 50);
                for (const [index, chunkText] of textChunks.entries()) {
                    const chunkTextLower = chunkText.toLowerCase();
                    let score = 0;
                    for (const [key, value] of Object.entries(POSITIVE_KEYWORDS)) {
                        if (chunkTextLower.includes(key))
                            score += value;
                    }
                    for (const [key, value] of Object.entries(NEGATIVE_KEYWORDS)) {
                        if (chunkTextLower.includes(key))
                            score += value;
                    }
                    if (score > 0) {
                        const chunk = {
                            source: `${relativePath}#chunk${index + 1}`,
                            text: chunkText
                        };
                        writeStream.write(JSON.stringify(chunk) + '\n');
                        relevantChunksCount++;
                    }
                }
            }
            catch (fileError) {
                console.error(`Erreur lors de la lecture du fichier ${file}:`, fileError);
            }
        }
        writeStream.end();
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
        if (relevantChunksCount === 0) {
            console.error(`\n❌ CRITIQUE: Aucun chunk pertinent trouvé pour ${path_1.default.basename(siteDir)}.`);
            return [];
        }
        console.log(`Indexation terminée. ${relevantChunksCount} chunks pertinents conservés.`);
        console.log(`\nPhase 2: Début de la Q&A...`);
        for (const question of allQuestions) {
            console.log(`\n  -> Question : "${question}"`);
            try {
                const indexContent = await fs_1.default.promises.readFile(indexPath, 'utf-8');
                const allIndexedChunks = indexContent
                    .split('\n')
                    .filter(Boolean)
                    .map(line => {
                    try {
                        return JSON.parse(line);
                    }
                    catch (parseError) {
                        console.error('Erreur de parsing JSON:', parseError);
                        return null;
                    }
                })
                    .filter(chunk => chunk !== null);
                const questionWords = question.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
                const keywords = questionWords.filter(word => !FRENCH_STOP_WORDS.has(word) && word.length > 2);
                let topChunks = [];
                if (keywords.length > 0) {
                    const scoredChunks = allIndexedChunks.map(chunk => {
                        const score = keywords.reduce((acc, key) => {
                            const matches = chunk.text.toLowerCase().match(new RegExp(`\\b${key}\\b`, 'g')) || [];
                            return acc + matches.length;
                        }, 0);
                        return { chunk, score };
                    }).filter(item => item.score > 0);
                    scoredChunks.sort((a, b) => b.score - a.score);
                    topChunks = scoredChunks.slice(0, MAX_CONTEXT_CHUNKS).map(item => item.chunk);
                }
                if (topChunks.length === 0) {
                    console.warn("       -> ⚠️ La recherche n'a rien donné. Utilisation du contexte par défaut.");
                    topChunks = allIndexedChunks.slice(0, MAX_CONTEXT_CHUNKS);
                }
                const contextForLLM = topChunks
                    .map(c => `Source: '${c.source}'\nContenu:\n${c.text}`)
                    .join('\n\n---\n\n')
                    .substring(0, MAX_CHUNK_SIZE_FOR_CONTEXT);
                const answer = await getAnswerFromOllama(question, contextForLLM);
                console.log(`     <- Réponse : ${answer}`);
                const cleanedAnswer = answer.toLowerCase().trim();
                let reponseTrouvee;
                if (answer.startsWith("Erreur")) {
                    reponseTrouvee = "erreur";
                }
                else if (NON_INFORMATIVE_RESPONSES.some(phrase => cleanedAnswer.includes(phrase))) {
                    reponseTrouvee = "non";
                }
                else {
                    reponseTrouvee = "oui";
                }
                siteQaResults.push({ question, answer, reponse_trouvee: reponseTrouvee });
                await delay(REQUEST_DELAY);
            }
            catch (questionError) {
                console.error(`Erreur lors du traitement de la question: ${question}`, questionError);
                siteQaResults.push({
                    question,
                    answer: "Erreur lors du traitement de la question",
                    reponse_trouvee: "erreur"
                });
            }
        }
    }
    finally {
        try {
            if (fs_1.default.existsSync(indexPath)) {
                await fs_1.default.promises.unlink(indexPath);
                console.log(`\nFichier d'index temporaire supprimé.`);
            }
        }
        catch (cleanupError) {
            console.error('Erreur lors du nettoyage:', cleanupError);
        }
    }
    return siteQaResults;
}
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});
app.get('/status', (req, res) => {
    res.status(200).json({
        status: "ok",
        message: "Server is running.",
        timestamp: new Date().toISOString(),
        ollama_url: OLLAMA_BASE_URL,
        crawl_dir: CRAWL_ROOT_DIR,
        questions_file: QUESTIONS_CSV_PATH
    });
});
app.get('/test-ollama', async (req, res) => {
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
        if (response.ok) {
            const models = await response.json();
            res.status(200).json({ status: "ok", models });
        }
        else {
            res.status(500).json({ status: "error", message: "Ollama not accessible" });
        }
    }
    catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});
app.post('/process-site', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: "Le paramètre 'url' est manquant ou invalide." });
    }
    console.log(`\nRequête reçue pour l'URL : ${url}`);
    try {
        let hostname;
        try {
            hostname = new url_1.URL(url).hostname;
        }
        catch (urlError) {
            return res.status(400).json({ error: "URL invalide fournie." });
        }
        const candidateHostnames = new Set();
        const bareHostname = hostname.replace(/^www\./, '').toLowerCase();
        candidateHostnames.add(bareHostname);
        candidateHostnames.add(bareHostname.replace(/\./g, '_'));
        candidateHostnames.add(hostname.replace(/\./g, '_'));
        candidateHostnames.add(bareHostname.replace(/[^a-z0-9]/g, '_'));
        candidateHostnames.add(hostname.replace(/[^a-z0-9]/g, '_'));
        candidateHostnames.add(bareHostname.replace(/[^a-z0-9]/g, ''));
        candidateHostnames.add(hostname.replace(/[^a-z0-9]/g, ''));
        const domainParts = bareHostname.split(/[\.\-]/).filter(p => p.length > 0);
        const relevantParts = domainParts.filter(part => part !== 'fr' && part !== 'com' && part !== 'org' && part.length > 0);
        if (relevantParts.length > 0) {
            candidateHostnames.add(relevantParts.join('_'));
            candidateHostnames.add(relevantParts.join(''));
            const lastRelevantPart = relevantParts[relevantParts.length - 1];
            candidateHostnames.add(lastRelevantPart);
            candidateHostnames.add(lastRelevantPart.replace(/[^a-z0-9]/g, '_'));
            candidateHostnames.add(lastRelevantPart.replace(/[^a-z0-9]/g, ''));
            const firstRelevantPart = relevantParts[0];
            candidateHostnames.add(firstRelevantPart);
            candidateHostnames.add(firstRelevantPart.replace(/[^a-z0-9]/g, '_'));
            candidateHostnames.add(firstRelevantPart.replace(/[^a-z0-9]/g, ''));
        }
        if (bareHostname.includes('musee')) {
            const noMuseeHostname = bareHostname.replace('musee-', '').replace('musee.', '').replace('musee_', '');
            if (noMuseeHostname.length > 0 && noMuseeHostname !== bareHostname) {
                candidateHostnames.add(noMuseeHostname);
                candidateHostnames.add(noMuseeHostname.replace(/[^a-z0-9]/g, '_'));
                candidateHostnames.add(noMuseeHostname.replace(/[^a-z0-9]/g, ''));
                const nmParts = noMuseeHostname.split(/[\.\-]/).filter(p => p.length > 0);
                if (nmParts.length > 0) {
                    const lastNmPart = nmParts[nmParts.length - 1];
                    candidateHostnames.add(lastNmPart);
                    candidateHostnames.add(lastNmPart.replace(/[^a-z0-9]/g, ''));
                }
            }
        }
        console.log(`Hostnames candidats générés pour comparaison :`, Array.from(candidateHostnames));
        if (!fs_1.default.existsSync(CRAWL_ROOT_DIR)) {
            return res.status(500).json({ error: "Le dossier des crawls n'existe pas sur le serveur." });
        }
        if (!fs_1.default.existsSync(QUESTIONS_CSV_PATH)) {
            return res.status(500).json({ error: "Le fichier de questions n'existe pas sur le serveur." });
        }
        const siteFolders = await fs_1.default.promises.readdir(CRAWL_ROOT_DIR, { withFileTypes: true })
            .then(dirents => dirents.filter(d => d.isDirectory()).map(d => d.name));
        if (siteFolders.length === 0) {
            return res.status(500).json({ error: "Aucun dossier de site trouvé sur le serveur." });
        }
        console.log(`Dossiers disponibles: ${siteFolders.join(', ')}`);
        let bestMatch = null;
        let lowestDistance = Infinity;
        let perfectMatchFound = false;
        for (const folderName of siteFolders) {
            if (candidateHostnames.has(folderName)) {
                bestMatch = folderName;
                perfectMatchFound = true;
                lowestDistance = 0;
                break;
            }
            for (const cHostname of candidateHostnames) {
                const distance = (0, leven_1.default)(cHostname, folderName);
                if (distance < lowestDistance) {
                    lowestDistance = distance;
                    bestMatch = folderName;
                }
            }
        }
        const originalHostnameForTolerance = bareHostname;
        const tolerance = Math.max(3, originalHostnameForTolerance.length * 0.3);
        if (!bestMatch || (!perfectMatchFound && lowestDistance > tolerance)) {
            console.error(`Aucun dossier correspondant trouvé pour '${hostname}'. Meilleur candidat : '${bestMatch}' (distance: ${lowestDistance}) rejeté (seuil: ${tolerance}).`);
            return res.status(404).json({
                error: `Aucun dossier de crawl trouvé correspondant à l'URL '${url}'.`,
                details: `Hostname '${hostname}' did not match available folders within tolerance.`,
                available_folders: siteFolders,
                best_match_candidate: bestMatch,
                distance: lowestDistance,
                tolerance: tolerance,
                candidate_hostnames_attempted: Array.from(candidateHostnames)
            });
        }
        console.log(`Meilleure correspondance trouvée : Dossier '${bestMatch}' pour l'URL '${url}' (distance: ${lowestDistance}${perfectMatchFound ? ' - MATCH PARFAIT' : ''})`);
        const siteDirPath = path_1.default.join(CRAWL_ROOT_DIR, bestMatch);
        console.log('Chargement des questions...');
        const allQuestions = await readQuestionsFromCsv(QUESTIONS_CSV_PATH);
        if (allQuestions.length === 0) {
            return res.status(500).json({ error: "Aucune question trouvée dans le fichier CSV." });
        }
        console.log(`${allQuestions.length} questions chargées, début du traitement...`);
        const results = await processSite(siteDirPath, allQuestions);
        if (results.length === 0) {
            return res.status(500).json({
                error: "Le traitement du site n'a produit aucun résultat.",
                site_folder_used: bestMatch
            });
        }
        console.log(`✅ Traitement terminé pour ${bestMatch}. Envoi de la réponse.`);
        return res.status(200).json({
            site_folder_used: bestMatch,
            hostname: hostname,
            candidate_hostnames_attempted: Array.from(candidateHostnames),
            questions_processed: allQuestions.length,
            results: results
        });
    }
    catch (error) {
        console.error("Une erreur critique est survenue durant le traitement :", error);
        return res.status(500).json({
            error: "Erreur interne du serveur.",
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});
const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 Serveur API démarré et à l'écoute sur http://${HOST}:${PORT}`);
    console.log(`   - Dossier des crawls : ${CRAWL_ROOT_DIR}`);
    console.log(`   - Fichier de questions : ${QUESTIONS_CSV_PATH}`);
    console.log(`   - Modèle Ollama : ${OLLAMA_LLM_MODEL}`);
    console.log(`   - URL Ollama : ${OLLAMA_BASE_URL}`);
    if (!fs_1.default.existsSync(CRAWL_ROOT_DIR)) {
        console.warn("⚠️  ATTENTION: Le dossier des crawls n'existe pas !");
    }
    else {
        console.log(`✅ Dossier des crawls trouvé`);
    }
    if (!fs_1.default.existsSync(QUESTIONS_CSV_PATH)) {
        console.warn("⚠️  ATTENTION: Le fichier de questions n'existe pas !");
    }
    else {
        console.log(`✅ Fichier de questions trouvé`);
    }
});
process.on('SIGTERM', () => {
    console.log('SIGTERM reçu, arrêt du serveur...');
    server.close(() => {
        console.log('Serveur arrêté proprement');
        process.exit(0);
    });
});
process.on('SIGINT', () => {
    console.log('SIGINT reçu, arrêt du serveur...');
    server.close(() => {
        console.log('Serveur arrêté proprement');
        process.exit(0);
    });
});
//# sourceMappingURL=server.js.map