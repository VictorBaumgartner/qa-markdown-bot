// worker.js

const fs = require('fs').promises;
const path = require('path');
const workerpool = require('workerpool');

/**
 * Traite un fichier, le découpe en morceaux, et émet chaque morceau
 * sous forme d'événement au lieu de renvoyer un grand tableau.
 * @param {string} file - Le chemin complet du fichier à traiter.
 * @param {string} siteDir - Le dossier racine du site pour calculer le chemin relatif.
 * @returns {Promise<number>} - Le nombre de chunks traités pour ce fichier.
 */
async function processFile(file, siteDir) {
    try {
        const content = await fs.readFile(file, 'utf8');
        const relativePath = path.relative(siteDir, file);
        const textChunks = content.split('\n\n').filter(chunk => chunk.trim());

        // NOUVEAU : Au lieu de construire un tableau, on émet chaque morceau.
        // C'est la modification clé pour éviter les transferts de données massifs.
        textChunks.forEach((chunk, index) => {
            workerpool.workerEmit({
                source: `${relativePath}#chunk${index + 1}`,
                text: chunk
            });
        });

        // On renvoie simplement une information légère, comme le nombre de morceaux.
        return textChunks.length;

    } catch (error) {
        // En cas d'erreur, on émet un événement d'erreur pour que le processus principal soit informé.
        console.error(`Error processing file in worker: ${file}: ${error.message}`);
        workerpool.workerEmit({
            error: `Failed to process file ${file}: ${error.message}`
        });
        return 0; // Ne renvoie aucun chunk traité.
    }
}

// Enregistre la fonction pour qu'elle soit appelable par le pool de workers.
workerpool.worker({
    processFile
});