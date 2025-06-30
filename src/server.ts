// src/server.ts

// --- Dépendances ---
import fs from 'fs';
import path from 'path';
import os from 'os';
import express, { Request, Response } from 'express';
import cors from 'cors';
import csv from 'csv-parser';
import leven from 'leven'; // Pour calculer la distance de Levenshtein (trouver le nom le plus proche)
import { URL } from 'url';


// =============================================================================
// --- Types et Interfaces ---
// =============================================================================
type QaClassification = "oui" | "non" | "erreur";

interface QAResult {
    question: string;
    answer: string;
    reponse_trouvee: QaClassification;
}

interface Chunk {
    source: string;
    text: string;
}

// =============================================================================
// --- Configuration ---
// =============================================================================
const HOST = "localhost"; // Changed from specific IP to localhost for development
const PORT = 3003;

const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_LLM_MODEL = "phi3";
const CRAWL_ROOT_DIR = path.join(__dirname, '..', 'crawl_output_csv');
const QUESTIONS_CSV_PATH = path.join(__dirname, '..', 'questions.csv');

// Paramètres de la logique
const REQUEST_DELAY = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_CONTEXT_CHUNKS = 7;
const MAX_CHUNK_SIZE_FOR_CONTEXT = 3500;

// Mots à ignorer et mots-clés de scoring (identiques à l'original)
const FRENCH_STOP_WORDS = new Set(['a', 'afin', 'ai', 'alors', 'au', 'aucun', 'aussi', 'autre', 'aux', 'avec', 'car', 'ce', 'ces', 'comme', 'dans', 'de', 'des', 'donc', 'dont', 'du', 'elle', 'en', 'est', 'et', 'eux', 'il', 'ils', 'je', 'la', 'le', 'les', 'leur', 'lui', 'ma', 'mais', 'me', 'mes', 'moi', 'mon', 'ne', 'nos', 'notre', 'nous', 'on', 'ou', 'où', 'par', 'pas', 'pour', 'qu', 'que', 'qui', 'sa', 'se', 'ses', 'son', 'sont', 'sur', 'ta', 'te', 'tes', 'toi', 'ton', 'tu', 'un', 'une', 'vos', 'votre', 'vous']);
const POSITIVE_KEYWORDS: { [key: string]: number } = { 'musée': 5, 'exposition': 5, 'collection': 4, 'galerie': 4, 'oeuvre': 4, 'artiste': 3, 'billet': 3, 'tarif': 3, 'horaires': 3, 'visite': 2, 'sculpture': 2, 'peinture': 2, 'archéologie': 2, 'patrimoine': 2 };
const NEGATIVE_KEYWORDS: { [key: string]: number } = { 'transport': -5, 'bus': -5, 'mairie': -4, 'administratif': -4, 'séance': -4, 'cabinet': -4, 'médical': -4, 'docteur': -4, 'urbanisme': -3, 'démarches': -3 };
const NON_INFORMATIVE_RESPONSES = ["l'information n'est pas disponible", "la réponse ne se trouve pas", "je ne peux pas répondre", "je ne trouve pas d'information", "la réponse à cette question ne peut pas être trouvée", "aucune information", "documents fournis ne contiennent pas", "documents ne précisent pas", "je ne trouve pas d'information pertinente et à jour"];

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// =============================================================================
// --- Fonctions Utilitaires (traduites en TypeScript) ---
// =============================================================================

function readQuestionsFromCsv(filePath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            return reject(new Error(`Le fichier de questions n'a pas été trouvé : ${filePath}`));
        }
        const questions: string[] = [];
        fs.createReadStream(filePath)
            .pipe(csv({ 
                headers: false, // Pas d'en-tête
                separator: ',' // Spécifier le séparateur
            }))
            .on('data', (row) => {
                // row est un objet avec des clés numériques (0, 1, 2, etc.)
                const question = row['0']; // Première colonne
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

async function getAnswerFromOllama(question: string, context: string): Promise<string> {
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
            const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout
            
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
            
            const result = await response.json() as { response?: string };
            const answer = result.response?.trim();
            
            if (!answer) {
                throw new Error("Réponse vide du modèle");
            }
            
            return answer;
        } catch (error: any) {
            console.error(`Erreur Ollama (tentative ${attempt}/${MAX_RETRIES}): ${error.message}`);
            if (attempt < MAX_RETRIES) {
                console.log(`Attente de ${RETRY_DELAY}ms avant nouvelle tentative...`);
                await delay(RETRY_DELAY);
            }
        }
    }
    return "Erreur lors de la communication avec le modèle de langage.";
}

// =============================================================================
// --- Logique de Traitement Principale pour UN SEUL SITE ---
// =============================================================================

async function processSite(siteDir: string, allQuestions: string[]): Promise<QAResult[]> {
    const siteQaResults: QAResult[] = [];
    // Créer un fichier d'index temporaire unique pour éviter les conflits
    const indexPath = path.join(os.tmpdir(), `index_${path.basename(siteDir)}_${Date.now()}.jsonl`);

    try {
        // --- Phase 1: Indexation et scoring ---
        console.log(`\nPhase 1: Indexation et scoring de ${path.basename(siteDir)}`);
        
        // Vérifier que le dossier existe
        if (!fs.existsSync(siteDir)) {
            throw new Error(`Le dossier ${siteDir} n'existe pas`);
        }
        
        // Fonction récursive pour trouver tous les fichiers .md
        const findMarkdownFiles = (dir: string): string[] => {
            const files: string[] = [];
            const items = fs.readdirSync(dir, { withFileTypes: true });
            
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    files.push(...findMarkdownFiles(fullPath));
                } else if (item.isFile() && item.name.endsWith('.md')) {
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

        const writeStream = fs.createWriteStream(indexPath);
        let relevantChunksCount = 0;

        for (const file of files) {
            try {
                const content = await fs.promises.readFile(file, 'utf8');
                const relativePath = path.relative(siteDir, file);
                const textChunks = content.split('\n\n').filter(chunk => chunk.trim().length > 50);

                for (const [index, chunkText] of textChunks.entries()) {
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

                    if (score > 0) {
                        const chunk: Chunk = { 
                            source: `${relativePath}#chunk${index + 1}`, 
                            text: chunkText 
                        };
                        writeStream.write(JSON.stringify(chunk) + '\n');
                        relevantChunksCount++;
                    }
                }
            } catch (fileError) {
                console.error(`Erreur lors de la lecture du fichier ${file}:`, fileError);
            }
        }
        
        writeStream.end();
        await new Promise<void>((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        if (relevantChunksCount === 0) {
            console.error(`\n❌ CRITIQUE: Aucun chunk pertinent trouvé pour ${path.basename(siteDir)}.`);
            return [];
        }
        console.log(`Indexation terminée. ${relevantChunksCount} chunks pertinents conservés.`);

        // --- Phase 2: Q&A ---
        console.log(`\nPhase 2: Début de la Q&A...`);
        for (const question of allQuestions) {
            console.log(`\n  -> Question : "${question}"`);
            
            try {
                // On lit l'index pour chaque question pour trouver le contexte pertinent
                const indexContent = await fs.promises.readFile(indexPath, 'utf-8');
                const allIndexedChunks: Chunk[] = indexContent
                    .split('\n')
                    .filter(Boolean)
                    .map(line => {
                        try {
                            return JSON.parse(line);
                        } catch (parseError) {
                            console.error('Erreur de parsing JSON:', parseError);
                            return null;
                        }
                    })
                    .filter(chunk => chunk !== null);

                const questionWords = question.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
                const keywords = questionWords.filter(word => !FRENCH_STOP_WORDS.has(word) && word.length > 2);
                
                let topChunks: Chunk[] = [];
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

                if (topChunks.length === 0) { // Plan B
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
                let reponseTrouvee: QaClassification;
                if (answer.startsWith("Erreur")) {
                    reponseTrouvee = "erreur";
                } else if (NON_INFORMATIVE_RESPONSES.some(phrase => cleanedAnswer.includes(phrase))) {
                    reponseTrouvee = "non";
                } else {
                    reponseTrouvee = "oui";
                }
                
                siteQaResults.push({ question, answer, reponse_trouvee: reponseTrouvee });
                await delay(REQUEST_DELAY);
            } catch (questionError) {
                console.error(`Erreur lors du traitement de la question: ${question}`, questionError);
                siteQaResults.push({ 
                    question, 
                    answer: "Erreur lors du traitement de la question", 
                    reponse_trouvee: "erreur" 
                });
            }
        }
    } finally {
        // --- Phase 3: Nettoyage ---
        try {
            if (fs.existsSync(indexPath)) {
                await fs.promises.unlink(indexPath);
                console.log(`\nFichier d'index temporaire supprimé.`);
            }
        } catch (cleanupError) {
            console.error('Erreur lors du nettoyage:', cleanupError);
        }
    }
    
    return siteQaResults;
}

// =============================================================================
// --- SERVEUR API EXPRESS ---
// =============================================================================

// =============================================================================
// --- SERVEUR API EXPRESS ---
// =============================================================================

const app = express();
app.use(cors());
app.use(express.json());

// Middleware pour logger les requêtes
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Endpoint pour vérifier que le serveur est en ligne
app.get('/status', (req: Request, res: Response) => {
    res.status(200).json({
        status: "ok",
        message: "Server is running.",
        timestamp: new Date().toISOString(),
        ollama_url: OLLAMA_BASE_URL,
        crawl_dir: CRAWL_ROOT_DIR,
        questions_file: QUESTIONS_CSV_PATH
    });
});

// Endpoint pour tester Ollama
app.get('/test-ollama', async (req: Request, res: Response) => {
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
        if (response.ok) {
            const models = await response.json();
            res.status(200).json({ status: "ok", models });
        } else {
            res.status(500).json({ status: "error", message: "Ollama not accessible" });
        }
    } catch (error: any) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// Endpoint principal pour traiter un site
app.post('/process-site', async (req: Request, res: Response) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: "Le paramètre 'url' est manquant ou invalide." });
    }

    console.log(`\nRequête reçue pour l'URL : ${url}`);

    try {
        // --- 1. Extraire le nom d'hôte de l'URL et le normaliser pour la comparaison ---
        let hostname: string;
        try {
            hostname = new URL(url).hostname;
        } catch (urlError) {
            return res.status(400).json({ error: "URL invalide fournie." });
        }

        // Préparer un ensemble de noms de dossiers cibles potentiels à partir du hostname de l'URL d'entrée
        const candidateHostnames = new Set<string>();

        // Commencer par une version nettoyée du hostname (sans www. et en minuscules)
        const bareHostname = hostname.replace(/^www\./, '').toLowerCase(); // ex: musee-du-louvre.fr

        // Ajouter les variations de base:
        candidateHostnames.add(bareHostname); // ex: musee-du-louvre.fr
        candidateHostnames.add(bareHostname.replace(/\./g, '_')); // ex: musee-du-louvre_fr
        candidateHostnames.add(hostname.replace(/\./g, '_')); // ex: www_musee-du-louvre_fr (garde www mais points en underscores)

        // Ajouter des variations avec tous les caractères non-alphanumériques (sauf underscores existants) convertis en underscores
        candidateHostnames.add(bareHostname.replace(/[^a-z0-9]/g, '_')); // ex: musee_du_louvre_fr
        candidateHostnames.add(hostname.replace(/[^a-z0-9]/g, '_')); // ex: www_musee_du_louvre_fr

        // Ajouter des versions entièrement "strippées" (aucun caractère spécial)
        candidateHostnames.add(bareHostname.replace(/[^a-z0-9]/g, '')); // ex: museedulouvrefr
        candidateHostnames.add(hostname.replace(/[^a-z0-9]/g, '')); // ex: wwwmuseedulouvrefr

        // Tenter d'extraire la "partie principale" du domaine, ex: "louvre" de "musee-du-louvre.fr"
        const domainParts = bareHostname.split(/[\.\-]/).filter(p => p.length > 0); // Diviser par points et tirets
        const relevantParts = domainParts.filter(part =>
            part !== 'fr' && part !== 'com' && part !== 'org' && part.length > 0
        );

        if (relevantParts.length > 0) {
            // Ajouter toutes les parties pertinentes jointes par underscore (ex: "musee_du_louvre")
            candidateHostnames.add(relevantParts.join('_'));
            candidateHostnames.add(relevantParts.join('')); // ex: "museedulouvre"

            // Ajouter la *dernière* partie pertinente (souvent la plus distinctive)
            const lastRelevantPart = relevantParts[relevantParts.length - 1];
            candidateHostnames.add(lastRelevantPart); // ex: "louvre"
            candidateHostnames.add(lastRelevantPart.replace(/[^a-z0-9]/g, '_')); // S'assurer des underscores s'il en reste
            candidateHostnames.add(lastRelevantPart.replace(/[^a-z0-9]/g, '')); // Dernière partie entièrement strippée

            // Ajouter la *première* partie pertinente (ex: "musee")
            const firstRelevantPart = relevantParts[0];
            candidateHostnames.add(firstRelevantPart); // ex: "musee"
            candidateHostnames.add(firstRelevantPart.replace(/[^a-z0-9]/g, '_'));
            candidateHostnames.add(firstRelevantPart.replace(/[^a-z0-9]/g, ''));
        }


        // Cas spécifique: si le hostname original contient "musee", tenter aussi le nom sans "musee"
        if (bareHostname.includes('musee')) {
            const noMuseeHostname = bareHostname.replace('musee-', '').replace('musee.', '').replace('musee_', '');
            if (noMuseeHostname.length > 0 && noMuseeHostname !== bareHostname) {
                candidateHostnames.add(noMuseeHostname); // ex: du-louvre.fr
                candidateHostnames.add(noMuseeHostname.replace(/[^a-z0-9]/g, '_')); // ex: du_louvre_fr
                candidateHostnames.add(noMuseeHostname.replace(/[^a-z0-9]/g, '')); // ex: dulouvrefr

                const nmParts = noMuseeHostname.split(/[\.\-]/).filter(p => p.length > 0);
                if (nmParts.length > 0) {
                    const lastNmPart = nmParts[nmParts.length - 1];
                    candidateHostnames.add(lastNmPart); // ex: louvre
                    candidateHostnames.add(lastNmPart.replace(/[^a-z0-9]/g, '')); // ex: louvre (stripped)
                }
            }
        }


        console.log(`Hostnames candidats générés pour comparaison :`, Array.from(candidateHostnames));

        // --- 2. Vérifier que les dossiers et fichiers existent ---
        if (!fs.existsSync(CRAWL_ROOT_DIR)) {
            return res.status(500).json({ error: "Le dossier des crawls n'existe pas sur le serveur." });
        }

        if (!fs.existsSync(QUESTIONS_CSV_PATH)) {
            return res.status(500).json({ error: "Le fichier de questions n'existe pas sur le serveur." });
        }

        // --- 3. Trouver le dossier correspondant ---
        const siteFolders = await fs.promises.readdir(CRAWL_ROOT_DIR, { withFileTypes: true })
            .then(dirents => dirents.filter(d => d.isDirectory()).map(d => d.name));

        if (siteFolders.length === 0) {
            return res.status(500).json({ error: "Aucun dossier de site trouvé sur le serveur." });
        }

        console.log(`Dossiers disponibles: ${siteFolders.join(', ')}`);

        let bestMatch: string | null = null;
        let lowestDistance = Infinity;
        let perfectMatchFound = false;

        for (const folderName of siteFolders) {
            // D'abord, vérifier les correspondances parfaites avec n'importe quel hostname candidat
            if (candidateHostnames.has(folderName)) {
                bestMatch = folderName;
                perfectMatchFound = true;
                lowestDistance = 0; // Correspondance parfaite
                break; // Correspondance parfaite trouvée, pas besoin de vérifier davantage
            }

            // Si aucune correspondance parfaite n'est trouvée, calculer la distance de Levenshtein
            // Pour chaque nom d'hôte candidat, trouver la meilleure distance avec le nom de dossier
            for (const cHostname of candidateHostnames) {
                const distance = leven(cHostname, folderName);
                // console.log(`Distance entre '${cHostname}' et '${folderName}': ${distance}`); // Décommenter pour un débogage détaillé
                if (distance < lowestDistance) {
                    lowestDistance = distance;
                    bestMatch = folderName;
                }
            }
        }

        // Seuil de tolérance : si la distance est > 30% de la longueur du nom d'hôte original non-www, on rejette
        // Ceci est une heuristique, à ajuster si nécessaire.
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
                candidate_hostnames_attempted: Array.from(candidateHostnames) // Ajouter les candidats pour le débogage
            });
        }

        console.log(`Meilleure correspondance trouvée : Dossier '${bestMatch}' pour l'URL '${url}' (distance: ${lowestDistance}${perfectMatchFound ? ' - MATCH PARFAIT' : ''})`);
        const siteDirPath = path.join(CRAWL_ROOT_DIR, bestMatch);

        // --- 4. Charger les questions et lancer le traitement ---
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

        // --- 5. Renvoyer la réponse ---
        console.log(`✅ Traitement terminé pour ${bestMatch}. Envoi de la réponse.`);
        return res.status(200).json({
            site_folder_used: bestMatch,
            hostname: hostname, // Retourne le hostname original pour plus de clarté
            candidate_hostnames_attempted: Array.from(candidateHostnames),
            questions_processed: allQuestions.length,
            results: results
        });

    } catch (error: any) {
        console.error("Une erreur critique est survenue durant le traitement :", error);
        return res.status(500).json({
            error: "Erreur interne du serveur.",
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// --- Lancement du serveur ---
const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 Serveur API démarré et à l'écoute sur http://${HOST}:${PORT}`);
    console.log(`   - Dossier des crawls : ${CRAWL_ROOT_DIR}`);
    console.log(`   - Fichier de questions : ${QUESTIONS_CSV_PATH}`);
    console.log(`   - Modèle Ollama : ${OLLAMA_LLM_MODEL}`);
    console.log(`   - URL Ollama : ${OLLAMA_BASE_URL}`);
    
    // Vérifications au démarrage
    if (!fs.existsSync(CRAWL_ROOT_DIR)) {
        console.warn("⚠️  ATTENTION: Le dossier des crawls n'existe pas !");
    } else {
        console.log(`✅ Dossier des crawls trouvé`);
    }
    
    if (!fs.existsSync(QUESTIONS_CSV_PATH)) {
        console.warn("⚠️  ATTENTION: Le fichier de questions n'existe pas !");
    } else {
        console.log(`✅ Fichier de questions trouvé`);
    }
});

// Gestion propre de l'arrêt du serveur
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